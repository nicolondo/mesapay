import { describe, expect, it } from "vitest";
import {
  editDistance,
  groupResults,
  highlightRanges,
  normalizeForSearch,
  prepareHelpIndex,
  queryTokens,
  searchHelp,
  splitHighlights,
  suggestQuery,
  type HelpIndexEntry,
} from "./search";

const entry = (e: Partial<HelpIndexEntry> & { s: string }): HelpIndexEntry => ({
  c: "facturacion",
  t: "",
  m: "",
  k: "",
  h: "",
  b: "",
  ...e,
});

const INDEX = prepareHelpIndex([
  entry({
    s: "activar-la-facturacion-electronica",
    t: "Activa la facturación electrónica",
    m: "Certificado, credenciales y set de pruebas de la DIAN.",
    k: "DIAN · factura electrónica · certificado digital",
    h: "Certificado digital · Habilitación",
    b: "Para emitir facturas electrónicas necesitas el certificado.",
  }),
  entry({
    s: "imprimir-facturas",
    c: "impresion-y-equipos",
    t: "Imprime y reimprime facturas",
    m: "Impresora de facturas y reimpresión.",
    k: "tirilla · reimprimir",
    b: "La factura sale por la impresora elegida. También puedes reimprimir una factura electrónica aceptada.",
  }),
  entry({
    s: "abrir-y-cerrar-el-turno",
    c: "cobro-y-caja",
    t: "Abre y cierra el turno",
    m: "Fondo inicial, arqueo y diferencia.",
    k: "cierre de caja · arqueo",
    h: "Cerrar el turno",
    b: "Al cerrar cuentas el efectivo contado. La contraseña no se pide.",
  }),
  entry({
    s: "cambiar-el-idioma",
    c: "primeros-pasos",
    t: "Cambia el idioma",
    m: "Español, inglés o portugués.",
    k: "idioma · language · inglés · portugués",
    b: "El selector está arriba, junto a tu nombre.",
  }),
]);

const slugs = (q: string) => searchHelp(INDEX, q).map((r) => r.entry.s);

describe("normalización", () => {
  it("quita tildes, mayúsculas y eñe", () => {
    expect(normalizeForSearch("Facturación ELECTRÓNICA · Contraseña")).toBe(
      "facturacion electronica · contrasena",
    );
  });
  it("saca las palabras de relleno salvo que no quede nada", () => {
    expect(queryTokens("¿Cómo hago para cerrar el turno?")).toEqual(["cerrar", "turno"]);
    expect(queryTokens("de la")).toEqual(["de", "la"]);
  });
});

describe("editDistance", () => {
  it("cuenta inserción, borrado, cambio y transposición como un error", () => {
    expect(editDistance("factura", "factura", 1)).toBe(0);
    expect(editDistance("factra", "factura", 1)).toBe(1);
    expect(editDistance("facturaa", "factura", 1)).toBe(1);
    expect(editDistance("fectura", "factura", 1)).toBe(1);
    expect(editDistance("fcatura", "factura", 1)).toBe(1);
    expect(editDistance("fcturaa", "factura", 1)).toBe(2);
  });
});

describe("searchHelp", () => {
  it("encuentra sin tildes: 'factura electronica'", () => {
    expect(slugs("factura electronica")[0]).toBe("activar-la-facturacion-electronica");
    expect(slugs("FACTURA ELECTRÓNICA")[0]).toBe("activar-la-facturacion-electronica");
  });

  it("encuentra con eñe o sin ella", () => {
    expect(slugs("contrasena")).toEqual(["abrir-y-cerrar-el-turno"]);
    expect(slugs("contraseña")).toEqual(["abrir-y-cerrar-el-turno"]);
  });

  it("coincide por prefijo de palabra", () => {
    expect(slugs("reimpr")).toEqual(["imprimir-facturas"]);
    expect(slugs("idio")).toEqual(["cambiar-el-idioma"]);
  });

  it("tolera una letra de error en palabras de 5+ letras", () => {
    expect(slugs("factuacion")).toContain("activar-la-facturacion-electronica");
    expect(slugs("arqeuo")).toEqual(["abrir-y-cerrar-el-turno"]);
    expect(slugs("trno")).toEqual([]); // 4 letras: sin tolerancia
  });

  it("título pesa más que el cuerpo", () => {
    const r = searchHelp(INDEX, "facturas");
    expect(r[0].entry.s).toBe("imprimir-facturas"); // en el título
    expect(r.map((x) => x.entry.s)).toContain("activar-la-facturacion-electronica");
  });

  it("palabras clave pesan más que subtítulos, resumen y cuerpo", () => {
    const only = (field: keyof HelpIndexEntry) =>
      prepareHelpIndex([entry({ s: field, [field]: "propina" })]);
    const score = (field: keyof HelpIndexEntry) => searchHelp(only(field), "propina")[0].score;
    expect(score("t")).toBeGreaterThan(score("k"));
    expect(score("k")).toBeGreaterThan(score("h"));
    expect(score("h")).toBeGreaterThan(score("m"));
    expect(score("m")).toBeGreaterThan(score("b"));
  });

  it("exige todas las palabras; si ninguno las tiene, devuelve parciales", () => {
    expect(slugs("cerrar turno")).toEqual(["abrir-y-cerrar-el-turno"]);
    const partial = searchHelp(INDEX, "cerrar xilofono");
    expect(partial.map((r) => r.entry.s)).toEqual(["abrir-y-cerrar-el-turno"]);
    expect(partial[0].partial).toBe(true);
  });

  it("sin coincidencias no devuelve nada", () => {
    expect(slugs("xilofono")).toEqual([]);
    expect(slugs("   ")).toEqual([]);
  });

  it("resalta el título y arma un fragmento del cuerpo", () => {
    const [r] = searchHelp(INDEX, "electronica certificado");
    const title = splitHighlights(r.entry.t, r.titleRanges);
    expect(title.filter((p) => p.hit).map((p) => p.text)).toEqual(["electrónica"]);
    const snippet = splitHighlights(r.snippet.text, r.snippet.ranges);
    // "electronica" es prefijo de "electrónicas": se resalta lo escrito.
    expect(snippet.filter((p) => p.hit).map((p) => p.text)).toEqual([
      "electrónica",
      "certificado",
    ]);
  });

  it("si sólo coincide el título, el fragmento es el resumen", () => {
    const [r] = searchHelp(INDEX, "idioma");
    expect(r.snippet.text).toBe("Español, inglés o portugués.");
  });

  it("resalta sólo el prefijo que se escribió", () => {
    const text = "Reimprimir factura";
    expect(splitHighlights(text, highlightRanges(text, ["reimp"]))).toEqual([
      { text: "Reimp", hit: true },
      { text: "rimir factura", hit: false },
    ]);
  });

  it("agrupa por categoría en el orden del mejor resultado", () => {
    const index = prepareHelpIndex([
      entry({ s: "a", c: "x", t: "Otra cosa", b: "La propina va aquí." }),
      entry({ s: "b", c: "y", t: "La propina" }),
      entry({ s: "c", c: "x", t: "Propinas compartidas" }),
    ]);
    const groups = groupResults(searchHelp(index, "propina"));
    expect(groups.map((g) => [g.category, g.results.map((r) => r.entry.s)])).toEqual([
      ["y", ["b"]],
      ["x", ["c", "a"]],
    ]);
  });

  it("a igual título, gana el que también lo tiene en otros campos", () => {
    const index = prepareHelpIndex([
      entry({ s: "solo-titulo", t: "Propina" }),
      entry({ s: "titulo-y-mas", t: "Propina", k: "propina", b: "propina" }),
    ]);
    expect(searchHelp(index, "propina").map((r) => r.entry.s)).toEqual([
      "titulo-y-mas",
      "solo-titulo",
    ]);
  });
});

describe("suggestQuery", () => {
  it("propone la palabra más parecida, con sus tildes", () => {
    expect(suggestQuery(INDEX, "cerificadoo digital")).toBe("certificado digital");
    expect(suggestQuery(INDEX, "electrnicaa")).toBe("electrónica");
  });
  it("no propone nada si ya hay resultados o si nada se parece", () => {
    expect(suggestQuery(INDEX, "turno")).toBeNull();
    expect(suggestQuery(INDEX, "xilofono")).toBeNull();
  });
});
