import { describe, expect, it } from "vitest";
import {
  applicableConcepts,
  CHECK_ORDER,
  detectSpike,
  runTaxChecks,
  sortChecks,
  supplierTaxIdIssue,
  type CheckKey,
  type ChecksInput,
  type RetentionConceptFull,
} from "./taxesChecks";
import type { PurchaseTaxInput, SaleTaxInput } from "./taxesDocuments";
import { ledgerFacts, purchaseFacts, salesFacts, type DocFact } from "./taxesDrill";
import { reconcileTaxes, type EngineOrder, type Reconciliation } from "./taxesReconcile";

const UVT = 5_237_400;

const sale = (id: string, over: Partial<SaleTaxInput> = {}): SaleTaxInput => ({
  invoiceId: id,
  document: `FE${id}`,
  dateIso: "2026-10-05T20:00:00.000Z",
  taxKind: "inc",
  taxPct: 8,
  baseCents: 100_000,
  taxCents: 8_000,
  customer: null,
  ...over,
});

const purchase = (id: string, over: Partial<PurchaseTaxInput> = {}): PurchaseTaxInput => ({
  purchaseId: id,
  document: `OC-${id}`,
  dateIso: "2026-10-06T15:00:00.000Z",
  supplierName: "Proveedor",
  supplierTaxId: "900123456-8",
  lines: [{ netCents: 100_000, taxPct: 0, taxCents: null, nonDeductibleTaxCents: 0 }],
  incCents: 0,
  retefuenteCents: 0,
  reteIvaCents: 0,
  reteIcaCents: 0,
  ...over,
});

const EMPTY_RECON: Reconciliation = {
  byTax: [],
  rows: { sinFactura: [], corte: [], cuentaAnulada: [], sinAsiento: [], desactualizado: [], sinDocumento: [] },
};

function base(over: Partial<ChecksInput> = {}): ChecksInput {
  const sales = over.sales ?? [sale("1")];
  const purchases = over.purchases ?? [purchase("p1")];
  const docs: readonly DocFact[] = over.docs ?? [...salesFacts(sales), ...purchaseFacts(purchases)];
  return {
    recon: EMPTY_RECON,
    sales,
    purchases,
    docs,
    currentTax: { kind: "inc", pct: 8 },
    purchaseIvaDeductible: true,
    concepts: [],
    uvtCents: UVT,
    cutoffHour: 5,
    entries: [],
    dianInvoices: new Map(),
    dianCreditNotes: [],
    ...over,
  };
}

const get = (input: ChecksInput, key: CheckKey) => runTaxChecks(input).find((c) => c.key === key)!;

describe("runTaxChecks — el caso limpio no tiene hallazgos", () => {
  it("todas las revisiones corren y pasan", () => {
    const checks = runTaxChecks(base());
    expect(checks.map((c) => c.key)).toEqual([...CHECK_ORDER]);
    for (const c of checks) expect([c.key, c.count]).toEqual([c.key, 0]);
  });
});

describe("DIAN", () => {
  it("rechazadas (crítico) y pendientes, con la nota del error", () => {
    const input = base({
      sales: [sale("1"), sale("2"), sale("3")],
      dianInvoices: new Map([
        ["1", { state: "rejected", lastError: "FAD06" }],
        ["2", { state: "to_send", lastError: null }],
        ["3", { state: "accepted", lastError: null }],
      ]),
      dianCreditNotes: [
        { id: "n1", document: "NC1", reference: "FE3", dateIso: "2026-10-07T00:00:00Z", state: "pending", taxCents: 400, party: null, nit: null },
      ],
    });
    const rej = get(input, "dianRechazada");
    expect(rej).toMatchObject({ severity: "critical", count: 1, amountCents: 8_000, taxes: ["inc"] });
    expect(rej.rows[0]).toMatchObject({ docId: "1", memo: "FAD06", flags: ["dianRejected"] });
    // Sin asiento del día todavía: la fila no inventa uno.
    expect(rej.rows[0]!.entryId).toBeUndefined();
    const withEntry = get({ ...input, entries: [{ id: "e5", source: "sale", day: "2026-10-05", voucher: "#000009" }] }, "dianRechazada");
    expect(withEntry.rows[0]).toMatchObject({ entryId: "e5", voucher: "#000009", day: "2026-10-05" });
    const pend = get(input, "dianPendiente");
    expect(pend.count).toBe(2);
    expect(pend.amountCents).toBe(8_000 - 400);
  });
});

describe("reconciliación como revisiones", () => {
  it("sin factura, corte, anuladas, sin asiento, desactualizado y sin documento salen de la reconciliación", () => {
    const orders: EngineOrder[] = [
      { orderId: "o1", shortCode: "A1", paidAtIso: "2026-10-05T20:00:00.000Z", status: "paid", invoiceId: null, slice: { kind: "inc", pct: 8, baseCents: 10_000, taxCents: 800 } },
    ];
    const ledger = ledgerFacts(
      [
        { id: "m", entryId: "e1", accountCode: "241205", debitCents: 0, creditCents: 300, dateIso: "2026-10-09T05:00:00Z", voucherNumber: 7, source: "manual", status: "posted" },
      ],
      [{ code: "241205", name: "INC", type: "pasivo" }],
    );
    const sales: SaleTaxInput[] = [];
    const recon = reconcileTaxes({
      period: { desde: "2026-10-01", hasta: "2026-10-31" },
      cutoffHour: 5,
      docs: [],
      windowSaleFacts: salesFacts(sales),
      windowPurchaseFacts: [],
      orders,
      ledger,
      entries: [],
    });
    const input = base({ recon, sales, purchases: [], docs: [] });
    expect(get(input, "sinFactura")).toMatchObject({ count: 1, amountCents: 800, params: { orders: 1 }, taxes: ["inc"] });
    // El pedido sin factura tampoco tiene asiento (no hay entradas): sale también como «sin asiento».
    expect(get(input, "sinAsiento")).toMatchObject({ count: 1, amountCents: 800 });
    expect(get(input, "sinDocumento")).toMatchObject({ count: 1, amountCents: 300 });
    expect(get(input, "sinDocumento").rows[0]).toMatchObject({ kind: "ledger", voucher: "#000007", source: "manual" });
    expect(get(input, "corte").count).toBe(0);
  });
});

describe("tarifa de las facturas", () => {
  it("tarifa distinta a la configurada", () => {
    const input = base({ sales: [sale("1"), sale("2", { taxKind: "inc", taxPct: 16 }), sale("3", { taxKind: "iva", taxPct: 19, taxCents: 19_000 })] });
    const c = get(input, "tarifaDistinta");
    expect(c.rows.map((r) => r.docId)).toEqual(["2", "3"]);
    expect(c.taxes).toEqual(["inc", "iva"]);
    expect(c.params).toEqual({ kind: "inc", pct: 8 });
  });
  it("sin impuesto (o gravada con impuesto 0) cuando el comercio cobra impuesto", () => {
    const input = base({ sales: [sale("1"), sale("2", { taxKind: "none", taxPct: 0, taxCents: 0 }), sale("3", { taxCents: 0 })] });
    const c = get(input, "sinImpuesto");
    expect(c.rows.map((r) => r.docId)).toEqual(["2", "3"]);
    expect(c.amountCents).toBe(200_000);
  });
  it("un comercio sin impuesto configurado no dispara ninguna de las dos", () => {
    const input = base({ currentTax: { kind: "none", pct: 0 }, sales: [sale("2", { taxKind: "none", taxPct: 0, taxCents: 0 })] });
    expect(get(input, "sinImpuesto").count).toBe(0);
    expect(get(input, "tarifaDistinta").count).toBe(0);
  });
});

describe("retenciones", () => {
  const compras: RetentionConceptFull = { kind: "retefuente", name: "Compras (2,5%)", rateBps: 250, base: "subtotal", thresholdUvt: 27, active: true };
  const reteica: RetentionConceptFull = { kind: "reteica", name: "ReteICA", rateBps: 70, base: "subtotal", thresholdUvt: 0, active: false };
  const big = 27 * UVT; // justo en el umbral

  it("omitida: concepto activo, base ≥ umbral y retención 0", () => {
    const input = base({
      concepts: [compras, reteica],
      purchases: [
        purchase("p1", { lines: [{ netCents: big, taxPct: 0, taxCents: null, nonDeductibleTaxCents: 0 }] }),
        purchase("p2", { lines: [{ netCents: big, taxPct: 0, taxCents: null, nonDeductibleTaxCents: 0 }], retefuenteCents: 3_535_245 }),
        purchase("p3", { lines: [{ netCents: big - 1, taxPct: 0, taxCents: null, nonDeductibleTaxCents: 0 }] }),
      ],
    });
    const c = get(input, "retencionOmitida");
    expect(c.rows.map((r) => r.docId)).toEqual(["p1"]);
    expect(c.amountCents).toBe(Math.round((big * 250) / 10_000));
    expect(c.rows[0]!.conceptName).toBe("Compras (2,5%)");
    expect(c.taxes).toEqual(["retefuente"]);
  });

  it("bajo el umbral: retuvo sin que ningún concepto activo aplique", () => {
    const input = base({
      concepts: [compras],
      purchases: [
        purchase("p1", { retefuenteCents: 2_500 }),
        purchase("p2", { lines: [{ netCents: big, taxPct: 0, taxCents: null, nonDeductibleTaxCents: 0 }], retefuenteCents: 9 }),
      ],
    });
    const c = get(input, "retencionBajoUmbral");
    expect(c.rows.map((r) => r.docId)).toEqual(["p1"]);
    expect(c.amountCents).toBe(2_500);
  });

  it("sin conceptos activos no hay a qué compararlas", () => {
    const input = base({ concepts: [{ ...compras, active: false }], purchases: [purchase("p1", { retefuenteCents: 2_500 })] });
    expect(get(input, "retencionBajoUmbral").count).toBe(0);
    expect(get(input, "retencionOmitida").count).toBe(0);
  });

  it("applicableConcepts: base sobre el IVA y umbral 0", () => {
    const reteiva: RetentionConceptFull = { kind: "reteiva", name: "ReteIVA 15%", rateBps: 1500, base: "tax", thresholdUvt: 0, active: true };
    expect(applicableConcepts([reteiva], "reteiva", { subtotalCents: 100, taxCents: 19_000 }, UVT)).toEqual([
      { concept: reteiva, amountCents: 2_850 },
    ]);
    expect(applicableConcepts([reteiva], "reteiva", { subtotalCents: 100, taxCents: 0 }, UVT)).toEqual([]);
  });
});

describe("IVA descontable sin ser responsable", () => {
  const withIva = [purchase("p1", { lines: [{ netCents: 100_000, taxPct: 19, taxCents: null, nonDeductibleTaxCents: 0 }] })];
  it("comercio configurado como NO descontable", () => {
    const c = get(base({ purchases: withIva, purchaseIvaDeductible: false, currentTax: { kind: "iva", pct: 19 }, sales: [] }), "ivaNoDescontable");
    expect(c).toMatchObject({ count: 1, amountCents: 19_000, params: { reason: "config" } });
  });
  it("comercio de impoconsumo (no genera IVA)", () => {
    const c = get(base({ purchases: withIva, purchaseIvaDeductible: true }), "ivaNoDescontable");
    expect(c.params).toEqual({ reason: "regime" });
    expect(c.count).toBe(1);
  });
  it("responsable de IVA con descontable: nada que revisar", () => {
    expect(get(base({ purchases: withIva, currentTax: { kind: "iva", pct: 19 }, sales: [] }), "ivaNoDescontable").count).toBe(0);
  });
  it("NO descontable y el motor ya lo lleva al costo: nada que revisar", () => {
    // Desde el arreglo del motor, la compra recibida sin IVA descontable trae
    // todo su IVA como no descontable (kardex al bruto) y nada llega a 2408.
    const atCost = [purchase("p1", { lines: [{ netCents: 100_000, taxPct: 19, taxCents: null, nonDeductibleTaxCents: 19_000 }] })];
    const c = get(base({ purchases: atCost, purchaseIvaDeductible: false, currentTax: { kind: "iva", pct: 19 }, sales: [] }), "ivaNoDescontable");
    expect(c).toMatchObject({ count: 0, params: { reason: "config" } });
  });
});

describe("terceros sin NIT", () => {
  it("compras con impuesto o retención de proveedores sin NIT o con DV errado", () => {
    const input = base({
      purchases: [
        purchase("p1", { supplierTaxId: null, retefuenteCents: 500 }),
        purchase("p2", { supplierTaxId: "900123456-1", retefuenteCents: 500 }),
        purchase("p3", { supplierTaxId: "900123456-8", retefuenteCents: 500 }),
        purchase("p4", { supplierTaxId: null }), // sin impuestos: no importa
      ],
    });
    const c = get(input, "terceroSinNit");
    expect(c.rows.map((r) => [r.docId, r.flags])).toEqual([
      ["p1", ["noNit"]],
      ["p2", ["invalidDv"]],
    ]);
  });
  it("supplierTaxIdIssue", () => {
    expect(supplierTaxIdIssue(null)).toBe("noNit");
    expect(supplierTaxIdIssue("  ")).toBe("noNit");
    expect(supplierTaxIdIssue("NIT 900123456-8")).toBeNull();
    expect(supplierTaxIdIssue("900.123.456-1")).toBe("invalidDv");
    expect(supplierTaxIdIssue("1020304050")).toBeNull();
  });
});

describe("notas crédito y variación", () => {
  it("notas crédito del período (informativo)", () => {
    const nota: DocFact = { ...salesFacts([sale("1")])[0]!, key: "nc:n1:inc:8", origin: "notas", docKind: "credit_note", taxCents: -800 };
    const c = get(base({ docs: [nota] }), "notasCredito");
    expect(c).toMatchObject({ severity: "info", count: 1, amountCents: -800, taxes: ["inc"] });
  });
  it("variación inusual contra el promedio", () => {
    const c = get(base({ trend: { inc: [100, 110, 90, 100, 105, 200], iva: [0, 0, 0, 0, 10, 0] } }), "variacion");
    expect(c.count).toBe(1);
    expect(c.spikes).toEqual([{ tax: "inc", currentCents: 200, averageCents: 101, changePct: 98 }]);
  });
  it("detectSpike necesita 3 períodos con cifra y ±50 %", () => {
    expect(detectSpike([0, 0, 100, 100, 300])).toBeNull();
    expect(detectSpike([100, 100, 100, 140])).toBeNull();
    expect(detectSpike([100, 100, 100, 40])).toEqual({ currentCents: 40, averageCents: 100, changePct: -60 });
  });
});

describe("sortChecks", () => {
  it("con hallazgos primero, por severidad; las que pasaron al final", () => {
    const input = base({
      sales: [sale("1"), sale("2", { taxPct: 16 })],
      dianInvoices: new Map([["1", { state: "rejected", lastError: null }]]),
      trend: { inc: [100, 100, 100, 100, 100, 300] },
    });
    const keys = sortChecks(runTaxChecks(input)).map((c) => c.key);
    expect(keys.slice(0, 3)).toEqual(["dianRechazada", "tarifaDistinta", "variacion"]);
  });
});

describe("factura emitida ANTES de cobrar (pendiente de pago)", () => {
  it("no es un hallazgo de ventas: no la marcan «cuentas anuladas» ni «cobradas sin factura» y pasa limpia", () => {
    // La cuenta sigue sin cobrar: `paidAt` null ⇒ ni el motor ni los
    // documentos del período la ven, así que la reconciliación no la nombra.
    const orders: EngineOrder[] = [];
    const recon = reconcileTaxes({
      period: { desde: "2026-10-01", hasta: "2026-10-31" },
      cutoffHour: 5,
      docs: salesFacts([sale("1")]),
      windowSaleFacts: salesFacts([sale("1")]),
      windowPurchaseFacts: [],
      orders: [{ orderId: "o1", shortCode: "A1", paidAtIso: "2026-10-05T20:00:00.000Z", status: "paid", invoiceId: "1", slice: { kind: "inc", pct: 8, baseCents: 100_000, taxCents: 8_000 } }, ...orders],
      ledger: [],
      entries: [],
    } as Parameters<typeof reconcileTaxes>[0]);
    const input = base({ recon, pendingPaymentSales: [sale("pre-1", { document: "FE77" })] });
    expect(get(input, "cuentaAnulada").count).toBe(0);
    expect(get(input, "sinFactura").count).toBe(0);
  });

  it("se lista como información, con su impuesto, el flag «pendiente de pago» y severidad info", () => {
    const c = get(base({ pendingPaymentSales: [sale("pre-1", { document: "FE77", taxCents: 12_000 })] }), "facturadaPendiente");
    expect(c).toMatchObject({ severity: "info", count: 1, amountCents: 12_000, taxes: ["inc"] });
    expect(c.rows[0]).toMatchObject({ docKind: "invoice", docId: "pre-1", document: "FE77", flags: ["pendingPayment"] });
  });

  it("sin facturas pendientes de pago la revisión pasa (y sin el dato, también)", () => {
    expect(get(base({ pendingPaymentSales: [] }), "facturadaPendiente").count).toBe(0);
    expect(get(base(), "facturadaPendiente").count).toBe(0);
  });
});

