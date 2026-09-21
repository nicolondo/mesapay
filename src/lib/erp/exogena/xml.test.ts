import { describe, expect, it } from "vitest";
import {
  buildCab,
  buildXml,
  dianFileName,
  dianIdType,
  encodePorcentajeBps,
  personAttrs,
  pesos,
  rec1001,
  rec1006,
  rec1011,
  recSaldo,
  splitNaturalName,
  terceroDoc,
  toLatin1,
  xmlEscape,
} from "./xml";

describe("cabecera y raíz", () => {
  it("<Cab> con el año del envío (gravable + 1), formato, versión, fechas del año y totales", () => {
    const cab = buildCab({
      formato: 1001,
      version: 11,
      anoEnvio: 2026,
      fecInicial: "2025-01-01",
      fecFinal: "2025-12-31",
      valorTotal: 1234.6,
      cantReg: 2,
      fecEnvio: "2026-05-10T10:00:00",
    });
    expect(cab).toBe(
      [
        "<Cab>",
        "  <Ano>2026</Ano>",
        "  <CodCpt>1</CodCpt>",
        "  <Formato>1001</Formato>",
        "  <Version>11</Version>",
        "  <NumEnvio>1</NumEnvio>",
        "  <FecEnvio>2026-05-10T10:00:00</FecEnvio>",
        "  <FecInicial>2025-01-01</FecInicial>",
        "  <FecFinal>2025-12-31</FecFinal>",
        "  <ValorTotal>1235</ValorTotal>",
        "  <CantReg>2</CantReg>",
        "</Cab>",
      ].join("\n"),
    );
  });

  it("buildXml declara ISO-8859-1 y envuelve en <mas>", () => {
    const xml = buildXml("<Cab/>", ["  <pagos/>"]);
    expect(xml.startsWith('<?xml version="1.0" encoding="ISO-8859-1"?>\n<mas>\n<Cab/>\n  <pagos/>\n</mas>')).toBe(true);
  });

  it("nombre oficial Dmuisca_01{formato 5}{versión 2}{año envío}00000001.xml", () => {
    expect(dianFileName("1001", 11, 2025)).toBe("Dmuisca_010100111202600000001.xml");
    expect(dianFileName("1006", 8, 2024)).toBe("Dmuisca_010100608202500000001.xml");
  });

  it("toLatin1 codifica los acentes en un byte (ISO-8859-1), no en UTF-8", () => {
    const bytes = toLatin1("CUANTÍAS");
    expect(bytes.length).toBe(8);
    expect(bytes[5]).toBe(0xcd); // Í
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it("pesos redondea los centavos al peso", () => {
    expect(pesos(123_449)).toBe(1234);
    expect(pesos(123_450)).toBe(1235);
  });

  it("xmlEscape protege los cinco caracteres reservados", () => {
    expect(xmlEscape(`A&B <"x"> 'y'`)).toBe("A&amp;B &lt;&quot;x&quot;&gt; &apos;y&apos;");
  });
});

describe("terceros", () => {
  it("dianIdType: CC 13, CE 22, NIT 31, PA 41, TI 42; desconocido → null", () => {
    expect(["CC", "CE", "NIT", "PA", "TI", "nit"].map(dianIdType)).toEqual(["13", "22", "31", "41", "42", "31"]);
    expect(dianIdType("RUC")).toBeNull();
    expect(dianIdType(null)).toBeNull();
  });

  it("terceroDoc: DV calculado SOLO para el tipo 31; los demás van sin DV", () => {
    expect(terceroDoc("31", "900.123.456")).toEqual({ tdoc: "31", nid: "900123456", dv: "8" });
    expect(terceroDoc("13", "1.020.304.050")).toEqual({ tdoc: "13", nid: "1020304050", dv: "" });
    // Pasaporte: alfanumérico.
    expect(terceroDoc("41", "AB-123 456")).toEqual({ tdoc: "41", nid: "AB123456", dv: "" });
  });

  it("splitNaturalName: última palabra → apl1, penúltima → apl2, primera → nom1, resto → nom2", () => {
    expect(splitNaturalName("Ana María Pérez Gómez")).toEqual({ apl1: "Gómez", apl2: "Pérez", nom1: "Ana", nom2: "María" });
    expect(splitNaturalName("Ana Pérez")).toEqual({ apl1: "Pérez", apl2: "", nom1: "Ana", nom2: "" });
    expect(splitNaturalName("Cher")).toEqual({ apl1: "Cher", apl2: "", nom1: "Cher", nom2: "" });
    expect(splitNaturalName("  ")).toEqual({ apl1: "", apl2: "", nom1: "", nom2: "" });
  });

  it("personAttrs: natural → apl/nom con raz vacía; jurídica → raz con nombres vacíos", () => {
    expect(personAttrs({ kind: "natural", name: "Juan Carlos Ruiz López" })).toEqual({
      apl1: "López", apl2: "Ruiz", nom1: "Juan", nom2: "Carlos", raz: "",
    });
    expect(personAttrs({ kind: "juridica", name: "Distribuidora Andina S.A.S." })).toEqual({
      apl1: "", apl2: "", nom1: "", nom2: "", raz: "Distribuidora Andina S.A.S.",
    });
  });

  it("encodePorcentajeBps: 33,3333 % (333333 bps) → por 3333330 con dec 5", () => {
    expect(encodePorcentajeBps(333_333)).toEqual({ por: 333_333_000, dec: 5 });
    expect(encodePorcentajeBps(10_000)).toEqual({ por: 10_000_000, dec: 5 });
  });
});

describe("registros por formato (atributos exactos y en orden)", () => {
  it("1001: <pagos> con los 20 atributos del anexo, vacíos los que faltan", () => {
    const r = rec1001({
      cpt: "5016", tdoc: "31", nid: "900123456", raz: "ACME S.A.S.",
      dir: "Cra 1 # 2-3", dpto: "05", mun: "001", pais: "169",
      pago: 1000, pnded: 0, ided: 190, inded: 0, retp: 25, reta: 0, comun: 0, ndom: 0,
    });
    expect(r).toBe(
      '  <pagos cpt="5016" tdoc="31" nid="900123456" apl1="" apl2="" nom1="" nom2="" raz="ACME S.A.S." dir="Cra 1 # 2-3" dpto="05" mun="001" pais="169" pago="1000" pnded="0" ided="190" inded="0" retp="25" reta="0" comun="0" ndom="0"/>',
    );
  });

  it("1006: <impoventas> con dv, imp/iva/icon", () => {
    const r = rec1006({ tdoc: "43", nid: "222222222222", dv: "", raz: "CONSUMIDOR FINAL", imp: 500, iva: 0, icon: 80 });
    expect(r).toBe(
      '  <impoventas tdoc="43" nid="222222222222" dv="" apl1="" apl2="" nom1="" nom2="" raz="CONSUMIDOR FINAL" imp="500" iva="0" icon="80"/>',
    );
  });

  it("1008/1009: mismo layout, distinto elemento", () => {
    const d = { cpt: "1315", tdoc: "13", nid: "123", dv: "", nom1: "Ana", apl1: "Pérez", dir: "", dpto: "0", mun: "0", pais: "169", sal: 700 };
    expect(recSaldo("saldoscc", d)).toBe(
      '  <saldoscc cpt="1315" tdoc="13" nid="123" dv="" apl1="Pérez" apl2="" nom1="Ana" nom2="" raz="" dir="" dpto="0" mun="0" pais="169" sal="700"/>',
    );
    expect(recSaldo("saldoscp", d)).toMatch(/^ {2}<saldoscp cpt="1315"/);
  });

  it("1011: <decl> sólo concepto y saldo", () => {
    expect(rec1011({ cpt: "8214", sal: 12 })).toBe('  <decl cpt="8214" sal="12"/>');
  });
});
