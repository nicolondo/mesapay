import { describe, expect, it } from "vitest";
import type { RetentionLedgerLine } from "./taxesDetail";
import type { PurchaseTaxInput, SaleTaxInput } from "./taxesDocuments";
import { DRILL_TAXES, ledgerFacts, purchaseFacts, salesFacts } from "./taxesDrill";
import type { TaxAccount } from "./taxesModel";
import {
  componentsTotal,
  engineDay,
  reconcileTaxes,
  type EngineEntry,
  type EngineOrder,
  type ReconInput,
} from "./taxesReconcile";

/**
 * Octubre de 2026 con corte a las 5 a. m.: el día de negocio D va de
 * D 10:00Z a D+1 10:00Z. Cada pedido / compra está puesto para disparar
 * UN componente de la diferencia.
 */
const PERIOD = { desde: "2026-10-01", hasta: "2026-10-31" };
const CUTOFF = 5;
const TO = Date.parse("2026-11-01T00:00:00.000Z");

const inv = (id: string, paidAt: string, tax: number): SaleTaxInput => ({
  invoiceId: id,
  document: `FE${id}`,
  dateIso: paidAt,
  taxKind: "inc",
  taxPct: 8,
  baseCents: tax * 12.5,
  taxCents: tax,
  customer: null,
});

const WINDOW_SALES: SaleTaxInput[] = [
  inv("1", "2026-10-05T20:00:00.000Z", 8_000), // normal
  inv("2", "2026-10-01T03:00:00.000Z", 700), // 30-sep 22:00 Bogotá → libro de septiembre
  inv("3", "2026-11-01T04:00:00.000Z", 2_400), // 31-oct 23:00 Bogotá → libro de octubre
  inv("5", "2026-10-12T20:00:00.000Z", 900), // cuenta anulada después de facturar
  inv("6", "2026-10-15T20:00:00.000Z", 1_100), // día sin asiento
];

const order = (
  id: string,
  paidAtIso: string,
  invoiceId: string | null,
  taxCents: number,
  status = "paid",
): EngineOrder => ({
  orderId: id,
  shortCode: `C${id}`,
  paidAtIso,
  status,
  invoiceId,
  slice: { kind: "inc", pct: 8, baseCents: taxCents * 12.5, taxCents },
});

const ORDERS: EngineOrder[] = [
  order("o1", "2026-10-05T20:00:00.000Z", "1", 8_000),
  order("o2", "2026-10-01T03:00:00.000Z", "2", 700),
  order("o3", "2026-11-01T04:00:00.000Z", "3", 2_400),
  order("o4", "2026-10-10T20:00:00.000Z", null, 1_600), // cobrado sin factura
  order("o5", "2026-10-12T20:00:00.000Z", "5", 900, "cancelled"),
  order("o6", "2026-10-15T20:00:00.000Z", "6", 1_100),
  order("o7", "2026-10-11T20:00:00.000Z", null, 0), // cortesía: no aporta
];

const purchase = (id: string, dateIso: string, ret: number): PurchaseTaxInput => ({
  purchaseId: id,
  document: `OC-${id}`,
  dateIso,
  supplierName: "Prov",
  supplierTaxId: "900111222",
  lines: [{ netCents: ret * 40, taxPct: 0, taxCents: null, nonDeductibleTaxCents: 0 }],
  incCents: 0,
  retefuenteCents: ret,
  reteIvaCents: 0,
  reteIcaCents: 0,
});

const WINDOW_PURCHASES = [
  purchase("p1", "2026-10-31T23:00:00.000Z", 5_000), // 31-oct 18:00 Bogotá: mismo día
  purchase("p2", "2026-11-01T08:00:00.000Z", 3_000), // 1-nov 03:00 Bogotá → día de negocio 31-oct
];

const ACCOUNTS: TaxAccount[] = [
  { code: "241205", name: "INC", type: "pasivo" },
  { code: "236505", name: "Retefuente", type: "pasivo" },
];

const ln = (id: string, code: string, credit: number, source: string, day: string, debit = 0): RetentionLedgerLine => ({
  id,
  entryId: `${source}-${day}`,
  accountCode: code,
  debitCents: debit,
  creditCents: credit,
  dateIso: `${day}T05:00:00.000Z`,
  voucherNumber: null,
  source,
  status: "posted",
});

const LINES: RetentionLedgerLine[] = [
  ln("a", "241205", 8_000, "sale", "2026-10-05"),
  ln("b", "241205", 1_000, "sale", "2026-10-10"), // el motor asentaría 1.600: desactualizado
  ln("c", "241205", 2_400, "sale", "2026-10-31"),
  ln("d", "241205", 500, "manual", "2026-10-20"),
  ln("e", "241205", 0, "taxpay", "2026-10-25", 300), // pago de la declaración
  ln("f", "236505", 8_000, "purchase", "2026-10-31"),
];

const ENTRIES: EngineEntry[] = [
  { id: "sale-2026-10-05", source: "sale", day: "2026-10-05" },
  { id: "sale-2026-10-10", source: "sale", day: "2026-10-10" },
  { id: "sale-2026-10-12", source: "sale", day: "2026-10-12" },
  { id: "sale-2026-10-31", source: "sale", day: "2026-10-31" },
  { id: "purchase-2026-10-31", source: "purchase", day: "2026-10-31" },
];

function input(over: Partial<ReconInput> = {}): ReconInput {
  const sales = WINDOW_SALES.filter((s) => Date.parse(s.dateIso) < TO);
  const purchases = WINDOW_PURCHASES.filter((p) => Date.parse(p.dateIso) < TO);
  return {
    period: PERIOD,
    cutoffHour: CUTOFF,
    docs: [...salesFacts(sales), ...purchaseFacts(purchases)],
    windowSaleFacts: salesFacts(WINDOW_SALES),
    windowPurchaseFacts: purchaseFacts(WINDOW_PURCHASES),
    orders: ORDERS,
    ledger: ledgerFacts(LINES, ACCOUNTS),
    entries: ENTRIES,
    ...over,
  };
}

describe("reconcileTaxes", () => {
  it("Σ componentes = libro − documentos, en cada impuesto", () => {
    const r = reconcileTaxes(input());
    for (const t of r.byTax) expect(componentsTotal(t), t.tax).toBe(t.diffCents);
    expect(r.byTax.map((t) => t.tax)).toEqual([...DRILL_TAXES]);
  });

  it("INC: cada causa con su cifra", () => {
    const inc = reconcileTaxes(input()).byTax.find((t) => t.tax === "inc")!;
    // doc = 8.000 + 700 + 900 + 1.100; libro = 8.000 + 1.000 + 2.400 + 500 − 300.
    expect(inc.diffCents).toBe(11_600 - 10_700);
    expect(inc.components).toEqual({
      sinFactura: 1_600,
      corte: 2_400 - 700,
      cuentaAnulada: -900,
      sinAsiento: -1_100,
      desactualizado: -600,
      sinDocumento: 200,
    });
  });

  it("las filas dicen qué documento o día explica cada parte", () => {
    const { rows } = reconcileTaxes(input());
    expect(rows.sinFactura.map((f) => [f.key, f.deltaCents, f.day])).toEqual([["ord:o4", 1_600, "2026-10-10"]]);
    expect(rows.corte.filter((f) => f.tax === "inc").map((f) => [f.key, f.deltaCents, f.day])).toEqual([
      ["inv:2", -700, "2026-09-30"],
      ["inv:3", 2_400, "2026-10-31"],
    ]);
    expect(rows.cuentaAnulada.map((f) => f.key)).toEqual(["inv:5"]);
    expect(rows.sinAsiento.map((f) => [f.key, f.deltaCents])).toEqual([["inv:6", -1_100]]);
    expect(rows.desactualizado.map((d) => [d.key, d.expectedCents, d.bookCents, d.entryId])).toEqual([
      ["inc|sale|2026-10-10", 1_600, 1_000, "sale-2026-10-10"],
    ]);
    expect(rows.sinDocumento.map((l) => [l.key, l.source, l.valueCents])).toEqual([
      ["d", "manual", 500],
      ["e", "taxpay", -300],
    ]);
  });

  it("retefuente: la compra que el motor asienta el 31 por el corte", () => {
    const r = reconcileTaxes(input());
    const ret = r.byTax.find((t) => t.tax === "retefuente")!;
    expect(ret.diffCents).toBe(3_000);
    expect(ret.components.corte).toBe(3_000);
    expect(r.rows.corte.filter((f) => f.tax === "retefuente").map((f) => f.docId)).toEqual(["p2"]);
  });

  it("todo cuadra cuando el libro es exactamente lo que dicen los documentos", () => {
    const docs = salesFacts([inv("1", "2026-10-05T20:00:00.000Z", 8_000)]);
    const r = reconcileTaxes({
      period: PERIOD,
      cutoffHour: CUTOFF,
      docs,
      windowSaleFacts: docs,
      windowPurchaseFacts: [],
      orders: [ORDERS[0]!],
      ledger: ledgerFacts([LINES[0]!], ACCOUNTS),
      entries: ENTRIES,
    });
    for (const t of r.byTax) {
      expect(t.diffCents).toBe(0);
      expect(Object.values(t.components).every((v) => v === 0)).toBe(true);
    }
    expect(Object.values(r.rows).every((rows) => rows.length === 0)).toBe(true);
  });

  it("devoluciones sin nota se cruzan en bloque (sin día)", () => {
    const refund = {
      ...salesFacts([inv("r", "2026-10-31T12:00:00.000Z", 800)])[0]!,
      key: "refunds",
      origin: "devoluciones" as const,
      docKind: "refund" as const,
      taxCents: -800,
    };
    const r = reconcileTaxes({
      period: PERIOD,
      cutoffHour: CUTOFF,
      docs: [refund],
      windowSaleFacts: [],
      windowPurchaseFacts: [],
      orders: [],
      ledger: ledgerFacts([ln("x", "241205", 0, "refund", "2026-10-07", 700)], ACCOUNTS),
      entries: [],
    });
    expect(r.rows.desactualizado).toEqual([
      expect.objectContaining({ day: null, expectedCents: -800, bookCents: -700, deltaCents: 100 }),
    ]);
    expect(componentsTotal(r.byTax.find((t) => t.tax === "inc")!)).toBe(100);
  });
});

describe("engineDay", () => {
  it("ventas y compras por día de negocio; notas y gastos por su fecha", () => {
    expect(engineDay("ventas", "2026-10-01T03:00:00.000Z", 5)).toBe("2026-09-30");
    expect(engineDay("compras", "2026-10-01T11:00:00.000Z", 5)).toBe("2026-10-01");
    expect(engineDay("notas", "2026-10-12T12:00:00.000Z", 5)).toBe("2026-10-12");
    expect(engineDay("gastos", "2026-10-12T00:00:00.000Z", 5)).toBe("2026-10-12");
    expect(engineDay("devoluciones", "2026-10-12T00:00:00.000Z", 5)).toBeNull();
  });
});
