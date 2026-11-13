// Catálogo de conceptos de retención (Colombia, año gravable vigente) y las
// reglas puras de un concepto: tarifa con decimales (1 %, 0,1 %, 1,5 %,
// reteICA por mil), nombre único por tipo, cuenta del tipo y el cálculo
// con el umbral en UVT.
import { describe, expect, it } from "vitest";
import es from "../../../messages/es.json";
import en from "../../../messages/en.json";
import pt from "../../../messages/pt.json";
import { UVT_POR_ANO } from "./exogena/normativa";
import {
  RETENTION_ACCOUNT_PREFIX,
  RETENTION_CATALOG,
  RETENTION_CATALOG_UVT_PESOS,
  RETENTION_CATALOG_YEAR,
  retentionCatalogEntry,
  retentionTopic,
} from "./retencionesCatalogo";
import {
  UVT_DEFAULT_CENTS,
  baseForKind,
  computeRetentions,
  conceptRateBps,
  conceptRatePpm,
  normalizeConceptName,
  parseRateToPpm,
  rateColumns,
  validateConceptFields,
  type ConceptFields,
} from "./retencionesCore";
import { pickPurchaseRetefuenteConcept, suggestPurchaseRetentions } from "./purchaseRetentions";
import { pickRetefuenteConcept, suggestExpenseRetentions } from "./expenseTax";

const UVT = UVT_DEFAULT_CENTS; // $52.374

describe("catálogo de retenciones", () => {
  it("la UVT del catálogo es la oficial del año (Res. DIAN 000238 de 2025) y la de la tabla de la exógena", () => {
    expect(RETENTION_CATALOG_YEAR).toBe(2026);
    expect(RETENTION_CATALOG_UVT_PESOS).toBe(52_374);
    expect(UVT_POR_ANO[RETENTION_CATALOG_YEAR]).toBe(RETENTION_CATALOG_UVT_PESOS);
    expect(UVT_DEFAULT_CENTS).toBe(RETENTION_CATALOG_UVT_PESOS * 100);
  });

  it("claves únicas; tipo, base y cuenta coherentes; fuente citada", () => {
    const keys = RETENTION_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of RETENTION_CATALOG) {
      expect(e.base).toBe(baseForKind(e.kind));
      expect(e.accountCode.startsWith(RETENTION_ACCOUNT_PREFIX[e.kind])).toBe(true);
      expect(e.accountCode).toMatch(/^\d{6}$/);
      expect(Number.isInteger(e.thresholdUvt) && e.thresholdUvt >= 0).toBe(true);
      expect(e.source.length).toBeGreaterThan(5);
      if (e.ratePpm !== null) expect(Number.isInteger(e.ratePpm) && e.ratePpm > 0 && e.ratePpm <= 1_000_000).toBe(true);
    }
    // Sólo la reteICA pide la tarifa (la fija cada municipio).
    expect(RETENTION_CATALOG.filter((e) => e.ratePpm === null).map((e) => e.kind)).toEqual(["reteica"]);
  });

  it("las cifras de 2026 (Decreto 572 de 2025 vigente desde el 1-jul-2026)", () => {
    const at = (key: string) => {
      const e = retentionCatalogEntry(key)!;
      return [e.ratePpm, e.thresholdUvt];
    };
    expect(at("compras_declarante")).toEqual([25_000, 10]);
    expect(at("compras_no_declarante")).toEqual([35_000, 10]);
    expect(at("servicios_declarante")).toEqual([40_000, 2]);
    expect(at("servicios_no_declarante")).toEqual([60_000, 2]);
    expect(at("honorarios_pj")).toEqual([110_000, 0]);
    expect(at("honorarios_pn")).toEqual([100_000, 0]);
    expect(at("arrendamiento_inmuebles")).toEqual([35_000, 10]);
    expect(at("transporte_carga")).toEqual([10_000, 2]);
    expect(at("transporte_pasajeros")).toEqual([35_000, 10]);
    expect(at("servicios_temporales")).toEqual([10_000, 2]);
    expect(at("vigilancia_aseo")).toEqual([20_000, 2]);
    expect(at("hoteles_restaurantes")).toEqual([35_000, 2]);
    expect(at("agricolas_sin_procesar")).toEqual([15_000, 70]);
    expect(at("compra_vehiculos")).toEqual([10_000, 10]);
    expect(at("reteiva_compras")).toEqual([150_000, 10]);
    expect(at("reteiva_servicios")).toEqual([150_000, 2]);
    expect(at("reteica_municipio")).toEqual([null, 0]);
  });

  it("cada concepto tiene su nombre (y su nota, si la tiene) en es, en y pt", () => {
    for (const msgs of [es, en, pt]) {
      const op = (msgs as { opErp: Record<string, string> }).opErp;
      for (const e of RETENTION_CATALOG) {
        expect(op[`retCat_${e.key}`], `${e.key} name`).toBeTruthy();
        if (e.hasNote) expect(op[`retCatNote_${e.key}`], `${e.key} note`).toBeTruthy();
      }
    }
  });

  it("tema: del catálogo si nació de él; si no, por el nombre", () => {
    expect(retentionTopic({ name: "Lo que sea", catalogKey: "transporte_carga" })).toBe("transporte");
    expect(retentionTopic({ name: "Compras (2,5%) — umbral 27 UVT" })).toBe("compras");
    expect(retentionTopic({ name: "Servicios (4%)" })).toBe("servicios");
    expect(retentionTopic({ name: "Arrendamientos (3,5%)" })).toBe("arrendamientos");
    expect(retentionTopic({ name: "Retención 1 %" })).toBeNull();
  });
});

describe("tarifa: % con decimales y por mil", () => {
  it("escribe 1, 0,1, 1,5 y 2.5 en %", () => {
    expect(parseRateToPpm("1", "pct")).toBe(10_000);
    expect(parseRateToPpm("0,1", "pct")).toBe(1_000);
    expect(parseRateToPpm("1,5", "pct")).toBe(15_000);
    expect(parseRateToPpm("2.5", "pct")).toBe(25_000);
    expect(parseRateToPpm(" 0,0001 ", "pct")).toBe(1);
    expect(parseRateToPpm("100", "pct")).toBe(1_000_000);
  });

  it("reteICA por mil: 4,14 ‰ = 4.140 ppm (41,4 bps, que no cabía en bps enteros)", () => {
    expect(parseRateToPpm("4,14", "permil")).toBe(4_140);
    expect(parseRateToPpm("11,04", "permil")).toBe(11_040);
    expect(parseRateToPpm("9,66", "permil")).toBe(9_660);
    expect(parseRateToPpm("0,001", "permil")).toBe(1);
  });

  it("rechaza cero, negativos, letras, más de 100 % y decimales de más", () => {
    for (const raw of ["", "0", "0,0", "-1", "abc", "1,2,3", "1%", "100,01", "0,00001"]) {
      expect(parseRateToPpm(raw, "pct"), raw).toBeNull();
    }
    expect(parseRateToPpm("4,1405", "permil")).toBeNull();
  });

  it("columnas: ratePpm exacto + rateBps redondeado (lo lee la versión anterior)", () => {
    expect(rateColumns(10_000)).toEqual({ rateBps: 100, ratePpm: 10_000 });
    expect(rateColumns(4_140)).toEqual({ rateBps: 41, ratePpm: 4_140 });
    expect(conceptRateBps({ rateBps: 41, ratePpm: 4_140 })).toBeCloseTo(41.4);
    expect(conceptRateBps({ rateBps: 250, ratePpm: null })).toBe(250);
    expect(conceptRatePpm({ rateBps: 250 })).toBe(25_000);
  });

  it("si la versión anterior del código cambió sólo rateBps, manda rateBps (blue/green, rollback)", () => {
    // Era 4 % (40.000 ppm, 400 bps); la versión vieja la subió a 6 % tocando sólo rateBps.
    expect(conceptRateBps({ rateBps: 600, ratePpm: 40_000 })).toBe(600);
    expect(conceptRatePpm({ rateBps: 600, ratePpm: 40_000 })).toBe(60_000);
    // Sin cambio: el redondeo coincide y vale la exacta.
    expect(conceptRatePpm({ rateBps: 41, ratePpm: 4_140 })).toBe(4_140);
  });
});

describe("validateConceptFields", () => {
  const ok: ConceptFields = {
    kind: "retefuente",
    name: "Retención 1 %",
    ratePpm: 10_000,
    base: "subtotal",
    thresholdUvt: 2,
    accountCode: "236505",
  };
  const ctx = {
    others: [
      { kind: "retefuente", name: "Transporte de carga" },
      { kind: "reteica", name: "ReteICA Bogotá" },
    ],
    allowedAccounts: ["236505", "236525"],
  };

  it("un concepto bien formado pasa", () => {
    expect(validateConceptFields(ok, ctx)).toBeNull();
  });

  it("tarifa: > 0, ≤ 100 % y entera en ppm", () => {
    expect(validateConceptFields({ ...ok, ratePpm: 0 }, ctx)).toBe("rate_invalid");
    expect(validateConceptFields({ ...ok, ratePpm: 1_000_001 }, ctx)).toBe("rate_invalid");
    expect(validateConceptFields({ ...ok, ratePpm: 10.5 }, ctx)).toBe("rate_invalid");
  });

  it("nombre único por comercio y TIPO, sin importar mayúsculas, tildes ni espacios", () => {
    expect(validateConceptFields({ ...ok, name: "  TRANSPORTE   de  cárga " }, ctx)).toBe("name_taken");
    // Mismo nombre en otro tipo: vale.
    expect(validateConceptFields({ ...ok, kind: "reteica", name: "Transporte de carga", accountCode: "236805" }, { ...ctx, allowedAccounts: ["236805"] })).toBeNull();
    expect(normalizeConceptName(" Retención  EN la Fuente ")).toBe("retencion en la fuente");
  });

  it("cuenta: una imputable del plan para ese tipo", () => {
    expect(validateConceptFields({ ...ok, accountCode: "236705" }, ctx)).toBe("account_invalid");
    expect(validateConceptFields({ ...ok, accountCode: "" }, ctx)).toBe("account_invalid");
  });

  it("nombre, umbral, tipo y base", () => {
    expect(validateConceptFields({ ...ok, name: " x " }, ctx)).toBe("name_invalid");
    expect(validateConceptFields({ ...ok, thresholdUvt: -1 }, ctx)).toBe("threshold_invalid");
    expect(validateConceptFields({ ...ok, thresholdUvt: 1.5 }, ctx)).toBe("threshold_invalid");
    expect(validateConceptFields({ ...ok, kind: "otro" }, ctx)).toBe("kind_invalid");
    // La reteIVA va sobre el IVA; la retefuente, sobre el subtotal.
    expect(validateConceptFields({ ...ok, base: "tax" }, ctx)).toBe("base_invalid");
  });
});

describe("la retención del 1 % con su umbral en UVT", () => {
  // Personalizada: 1 %, base mínima 2 UVT ($104.748).
  const unoPorCiento = {
    id: "c1",
    kind: "retefuente",
    name: "Retención 1 %",
    rateBps: conceptRateBps(rateColumns(10_000)),
    base: "subtotal",
    thresholdUvt: 2,
    accountCode: "236505",
    active: true,
    catalogKey: null,
  };
  const dosUvt = 2 * UVT;

  it("computeRetentions: por debajo de 2 UVT no retiene; desde 2 UVT, el 1 % de la base", () => {
    expect(computeRetentions([unoPorCiento], { subtotalCents: dosUvt - 1, taxCents: 0 }, UVT).lines).toEqual([]);
    const r = computeRetentions([unoPorCiento], { subtotalCents: 100_000_000, taxCents: 0 }, UVT);
    expect(r.retefuenteCents).toBe(1_000_000); // 1 % de $1.000.000
    expect(computeRetentions([unoPorCiento], { subtotalCents: dosUvt, taxCents: 0 }, UVT).retefuenteCents).toBe(
      Math.round(dosUvt / 100),
    );
  });

  it("reteICA 4,14 ‰ con la precisión exacta (no 4,1 ‰)", () => {
    const ica = { ...unoPorCiento, id: "ica", kind: "reteica", thresholdUvt: 0, rateBps: conceptRateBps(rateColumns(4_140)) };
    expect(computeRetentions([ica], { subtotalCents: 100_000_000, taxCents: 0 }, UVT).reteIcaCents).toBe(414_000);
  });

  it("compras: sin «compras» activo se sugiere la del 1 %; con «compras» activo, esa", () => {
    const doc = { baseCents: 50_000_000, ivaCents: 0 };
    expect(suggestPurchaseRetentions([unoPorCiento], doc, UVT).map((s) => [s.conceptId, s.amountCents])).toEqual([
      ["c1", 500_000],
    ]);
    const compras = { ...unoPorCiento, id: "cmp", name: "Lo que el contador llamó", catalogKey: "compras_declarante", rateBps: 250, thresholdUvt: 10 };
    expect(pickPurchaseRetefuenteConcept([unoPorCiento, compras])?.id).toBe("cmp");
  });

  it("gastos: la retefuente por tema del catálogo (transporte no se toma por «servicios»)", () => {
    const transporte = { ...unoPorCiento, id: "tr", name: "Transporte de carga", catalogKey: "transporte_carga" };
    const servicios = { ...unoPorCiento, id: "sv", name: "Servicios generales (declarantes)", catalogKey: "servicios_declarante", rateBps: 400 };
    expect(pickRetefuenteConcept([transporte, servicios], { category: "Mantenimiento" })?.id).toBe("sv");
    const s = suggestExpenseRetentions([transporte], { baseCents: dosUvt - 1, ivaCents: 0 }, UVT);
    expect(s).toEqual([]);
    expect(suggestExpenseRetentions([transporte], { baseCents: 30_000_000, ivaCents: 0 }, UVT)[0]?.amountCents).toBe(300_000);
  });
});
