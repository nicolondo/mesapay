// Factura emitida ANTES de cobrar: el papel que se le lleva a la mesa.
// "Pendiente de pago" en vez de la forma de pago, y la propina sugerida
// APARTE y sin sumar: el TOTAL A PAGAR lleva sólo la propina que se cobró
// de verdad (la de la orden), que antes de cobrar es ninguna. Una vez
// cobrada, la reimpresión muestra lo cobrado y el TOTAL A PAGAR con la
// propina REAL que dejaron ($ 120,000 + $ 12,000 = $ 132,000).
import { describe, expect, it } from "vitest";
import { readPaper } from "./testPaper";
import { formatNumber } from "@/lib/format";
import {
  INVOICE_PAYLOAD_VERSION,
  parseInvoicePayload,
  renderInvoice,
  type ThermalInvoice,
} from "./invoice";
import { buildThermalInvoice, pendingPaymentOf, type InvoicePaymentLine } from "@/lib/print/invoiceDoc";
import type { InvoiceSnapshot } from "@/lib/invoice";

const LABELS: Record<string, string> = {
  receiptLabel: "Comprobante",
  einvoiceLabel: "FACTURA ELECTRÓNICA DE VENTA",
  subtotal: "Subtotal",
  total: "TOTAL",
  tip: "Propina",
  invoiceTotal: "Total factura",
  receiptTotal: "Total comprobante",
  tipVoluntary: "Propina voluntaria",
  totalToPay: "TOTAL A PAGAR",
  paymentTitle: "Forma de pago",
  paymentPending: "Pendiente de pago",
  methodCash: "Efectivo",
  methodCardTerminal: "Tarjeta · datáfono",
  prebillTotalWithTip: "TOTAL CON PROPINA",
  prebillTipVoluntary: "La propina es voluntaria: puedes aceptarla, rechazarla o cambiarla.",
  date: "Fecha",
  thanks: "Gracias",
  tipNoticeTitle: "ADVERTENCIA DE PROPINA",
  tipNoticeBody: "LA PROPINA ES SUGERIDA",
  dianCufeLabel: "CUFE",
  einvoiceVerify: "Consulta",
  einvoiceRepresentation: "Representación impresa",
  customerLabel: "Cliente",
  finalConsumer: "Consumidor final",
};
const t = (key: string, values?: Record<string, string | number>) =>
  key === "suggestedTipVoluntary"
    ? `Propina sugerida (voluntaria) ${values?.pct}%`
    : (LABELS[key] ?? key);
const money = (cents: number) => `$ ${formatNumber(Math.round(cents / 100))}`;

const snapshot: InvoiceSnapshot = {
  restaurantName: "Son y Melona",
  logoUrl: null,
  legalName: "SON Y MELONA S.A.S.",
  taxId: "901944469",
  legalAddress: null,
  legalCity: null,
  legalPhone: null,
  dianResolution: "18764094877213",
  dianResolutionFrom: 1,
  dianResolutionTo: 10000,
  dianResolutionDate: null,
  invoicePrefix: "FESM",
  shortCode: "A4F2",
  tableLabel: "Mesa 7",
  paidAtIso: "2026-11-04T23:10:00.000Z",
  items: [{ qty: 2, name: "Bandeja paisa", priceCents: 5_000_000 }],
  subtotalCents: 10_000_000,
  taxCents: 0,
  discountCents: 0,
  tipCents: 0,
  totalCents: 10_000_000,
  customer: null,
  issuedBeforePayment: true,
  orderItemIds: ["it-1"],
};

const build = (
  snap: InvoiceSnapshot,
  payments: InvoicePaymentLine[] = [],
  dian = false,
  // La orden HOY: su propina es la suma de las de los pagos aprobados.
  order: { tipCents: number } | null = {
    tipCents: payments.reduce((sum, p) => sum + p.tipCents, 0),
  },
  paperWidthMm = 80,
) =>
  buildThermalInvoice({
    snapshot: snap,
    invoiceNumber: 6490,
    paperWidthMm,
    paidAtLabel: "4/11/26, 18:10",
    dianResolutionDateLabel: null,
    payments,
    money,
    t,
    dian: dian ? { cufe: "c".repeat(96), verifyUrl: "https://catalogo-vpfe.dian.gov.co/x", qr: false } : null,
    order,
  });
const paper = (doc: ThermalInvoice) => readPaper(renderInvoice(doc)).text;

describe("pendingPaymentOf", () => {
  it("sin pagos: falta todo y la propina sugerida es el 10 % de eso", () => {
    expect(pendingPaymentOf(snapshot, [])).toEqual({
      outstandingCents: 10_000_000,
      paidFoodCents: 0,
      paidTipCents: 0,
      suggestedTipPct: 10,
      suggestedTipCents: 1_000_000,
    });
  });
  it("lo cobrado cuenta sin su propina (amountCents − tipCents)", () => {
    const r = pendingPaymentOf(snapshot, [{ method: "cash", amountCents: 5_500_000, tipCents: 500_000 }]);
    expect(r).toMatchObject({ outstandingCents: 5_000_000, paidFoodCents: 5_000_000, paidTipCents: 500_000 });
  });
  it("una factura emitida al cobrar no tiene nada pendiente que mostrar", () => {
    expect(pendingPaymentOf({ ...snapshot, issuedBeforePayment: undefined }, [])).toBeNull();
  });
});

describe("papel de la factura emitida antes de cobrar", () => {
  it("sin pagos: TOTAL A PAGAR = total factura, 'Pendiente de pago' y la propina sugerida aparte, SIN sumar", () => {
    const doc = build(snapshot);
    expect(doc.totals.slice(-2)).toEqual([
      { label: "Total comprobante", amount: "$ 100,000" },
      { label: "TOTAL A PAGAR", amount: "$ 100,000", strong: true },
    ]);
    expect(doc.paymentTitle).toBeNull();
    expect(doc.paymentRows).toEqual([]);
    expect(doc.pendingRow).toEqual({ label: "Pendiente de pago", amount: "$ 100,000", bold: true });
    expect(doc.tipRows).toEqual([{ label: "Propina sugerida (voluntaria) 10%", amount: "$ 10,000" }]);
    expect(doc.tipNotice).toBeUndefined();
    const text = paper(doc);
    expect(text).toContain("Pendiente de pago");
    expect(text).toContain("Propina sugerida (voluntaria) 10%");
    expect(text).not.toContain("Forma de pago");
    expect(text).not.toContain("TOTAL CON PROPINA");
    // Un solo total grande, y es el de la venta: la sugerida NO está sumada.
    expect(text).toMatch(/TOTAL A PAGAR +\$ 100,000/);
    expect(text).not.toContain("110.000");
  });

  it("como factura electrónica aceptada lleva el CUFE, «Total factura» y también el 'Pendiente de pago'", () => {
    const text = paper(build(snapshot, [], true));
    expect(text).toContain("FACTURA ELECTRÓNICA DE VENTA");
    expect(text).toContain("CUFE:");
    expect(text).toMatch(/Total factura +\$ 100,000/);
    expect(text).toContain("Pendiente de pago");
  });

  it("con un pago parcial (cuenta dividida): la propina cobrada suma al TOTAL A PAGAR; lo pendiente es la venta que falta", () => {
    const doc = build(snapshot, [{ method: "cash", amountCents: 5_500_000, tipCents: 500_000 }]);
    expect(doc.totals.slice(-3)).toEqual([
      { label: "Total comprobante", amount: "$ 100,000" },
      { label: "Propina voluntaria", amount: "$ 5,000" },
      { label: "TOTAL A PAGAR", amount: "$ 105,000", strong: true },
    ]);
    // Lo cobrado, con su propina adentro: pagado + pendiente = TOTAL A PAGAR.
    expect(doc.paymentRows).toEqual([{ label: "Efectivo", amount: "$ 55,000" }]);
    expect(doc.pendingRow).toEqual({ label: "Pendiente de pago", amount: "$ 50,000", bold: true });
    expect(doc.tipRows?.[0]).toEqual({ label: "Propina sugerida (voluntaria) 10%", amount: "$ 5,000" });
  });

  it("reimpresa ya cobrada: TOTAL A PAGAR con la propina REAL de la orden, sin pendiente ni sugerida", () => {
    // $ 120,000 de consumo (impoconsumo incluido) y $ 12,000 de propina
    // decidida al pagar: el snapshot de la factura no la tiene (0).
    const snap: InvoiceSnapshot = {
      ...snapshot,
      items: [{ qty: 1, name: "Consumo", priceCents: 12_000_000 }],
      subtotalCents: 12_000_000,
      totalCents: 12_000_000,
      tipCents: 0,
    };
    const doc = build(snap, [{ method: "external_terminal", amountCents: 13_200_000, tipCents: 1_200_000 }], true);
    expect(doc.totals.slice(-3)).toEqual([
      { label: "Total factura", amount: "$ 120,000" },
      { label: "Propina voluntaria", amount: "$ 12,000" },
      { label: "TOTAL A PAGAR", amount: "$ 132,000", strong: true },
    ]);
    expect(doc.pendingRow).toBeNull();
    expect(doc.tipRows).toEqual([]);
    const text = paper(doc);
    expect(text).not.toContain("Pendiente de pago");
    expect(text).toMatch(/TOTAL A PAGAR +\$ 132,000/);
  });

  it("la propina sale de la ORDEN, no del snapshot ni de adivinarla", () => {
    const payments = [
      { method: "cash", amountCents: 6_000_000, tipCents: 0 },
      { method: "kushki_card_terminal", amountCents: 4_800_000, tipCents: 800_000 },
    ];
    const doc = build(snapshot, payments, false, { tipCents: 800_000 });
    expect(doc.paymentRows).toEqual([
      { label: "Efectivo", amount: "$ 60,000" },
      { label: "Tarjeta · datáfono", amount: "$ 48,000" },
    ]);
    expect(doc.totals.find((r) => r.strong)).toEqual({ label: "TOTAL A PAGAR", amount: "$ 108,000", strong: true });
    // Sin la orden (p. ej. la tirilla de muestra): sin propina que sumar.
    expect(build(snapshot, payments, false, null).totals.find((r) => r.strong)?.amount).toBe("$ 100,000");
  });

  it("una factura emitida al cobrar no usa la orden: la propina es la de su snapshot", () => {
    const doc = build(
      { ...snapshot, issuedBeforePayment: undefined, tipCents: 1_000_000, totalCents: 11_000_000 },
      [{ method: "cash", amountCents: 11_000_000, tipCents: 1_000_000 }],
      false,
      { tipCents: 999_999 },
    );
    expect("pendingRow" in doc).toBe(false);
    expect("tipRows" in doc).toBe(false);
    expect(doc.totals.slice(-3)).toEqual([
      { label: "Total comprobante", amount: "$ 100,000" },
      { label: "Propina voluntaria", amount: "$ 10,000" },
      { label: "TOTAL A PAGAR", amount: "$ 110,000", strong: true },
    ]);
    expect(doc.paymentRows).toEqual([{ label: "Efectivo", amount: "$ 110,000" }]);
  });

  it("el payload guardado en la cola conserva el pendiente (en negrita) y la propina sugerida", () => {
    const doc = build(snapshot);
    const parsed = parseInvoicePayload(JSON.parse(JSON.stringify({ v: INVOICE_PAYLOAD_VERSION, invoice: doc })));
    expect(parsed?.pendingRow).toEqual(doc.pendingRow);
    expect(parsed?.tipRows).toEqual(doc.tipRows);
    expect(renderInvoice(parsed!).equals(renderInvoice(doc))).toBe(true);
  });

  it("un payload VIEJO (TOTAL CON PROPINA fuerte, aviso) se sigue imprimiendo tal cual", () => {
    const old: ThermalInvoice = {
      ...build(snapshot),
      pendingRow: { label: "Pendiente de pago", amount: "$ 100,000", strong: true },
      tipRows: [
        { label: "Propina sugerida 10%", amount: "$ 10,000" },
        { label: "TOTAL CON PROPINA", amount: "$ 110,000", strong: true },
      ],
      tipNotice: "La propina es voluntaria: puedes aceptarla, rechazarla o cambiarla.",
    };
    const parsed = parseInvoicePayload(JSON.parse(JSON.stringify({ v: INVOICE_PAYLOAD_VERSION, invoice: old })));
    expect(renderInvoice(parsed!).equals(renderInvoice(old))).toBe(true);
    const text = paper(old);
    expect(text).toContain("TOTAL CON PROPINA");
    expect(text).toContain("La propina es voluntaria");
  });

  it.each([58, 80])("en %i mm entra todo, sin renglones de más del ancho del papel", (mm) => {
    const doc = build(snapshot, [{ method: "cash", amountCents: 5_500_000, tipCents: 500_000 }], true, undefined, mm);
    const p = readPaper(renderInvoice(doc));
    const cols = mm === 58 ? 32 : 48;
    // Ningún renglón se pasa del ancho (fuente A 12 puntos, B 9).
    for (const row of p.rows) expect(row.widthDots).toBeLessThanOrEqual(cols * 12);
    expect(p.text).toContain("Pendiente de pago");
    expect(p.text).toMatch(/TOTAL A PAGAR +\$ 105,000/);
    expect(p.text.replace(/\s+/g, " ")).toContain("Propina sugerida (voluntaria) 10%");
  });
});

// El dueño: «se escogió que la factura iba sin propina y la factura salió
// con una propina sugerida con un nuevo total con la propina incluida.
// Necesito que cuando las facturas no vayan con propina no salga nada de
// propina sugerida». La elección del cobro queda en `suggestedTipPct`.
describe("la propina elegida en el cobro al emitir (suggestedTipPct)", () => {
  const sinPropina: InvoiceSnapshot = { ...snapshot, suggestedTipPct: 0 };

  it("«Sin propina»: ni propina sugerida ni total con propina; TOTAL A PAGAR = total factura", () => {
    expect(pendingPaymentOf(sinPropina, [])).toMatchObject({ suggestedTipPct: 0, suggestedTipCents: 0 });
    for (const mm of [80, 58]) {
      const doc = build(sinPropina, [], true, { tipCents: 0 }, mm);
      expect(doc.tipRows).toEqual([]);
      expect(doc.totals.slice(-2)).toEqual([
        { label: "Total factura", amount: "$ 100,000" },
        { label: "TOTAL A PAGAR", amount: "$ 100,000", strong: true },
      ]);
      const text = paper(doc);
      expect(text).not.toContain("Propina sugerida");
      expect(text).not.toContain("TOTAL CON PROPINA");
      expect(text).not.toContain("Propina voluntaria");
      expect(text).not.toContain("110.000");
      // Lo que falta cobrar sí: la factura sigue pendiente de pago.
      expect(text).toContain("Pendiente de pago");
    }
  });

  it("«Sin propina» y el cliente igual deja propina al pagar: sale sólo como propina voluntaria real", () => {
    const doc = build(sinPropina, [{ method: "cash", amountCents: 10_500_000, tipCents: 500_000 }]);
    expect(doc.totals.slice(-3)).toEqual([
      { label: "Total comprobante", amount: "$ 100,000" },
      { label: "Propina voluntaria", amount: "$ 5,000" },
      { label: "TOTAL A PAGAR", amount: "$ 105,000", strong: true },
    ]);
    expect(doc.tipRows).toEqual([]);
    expect(paper(doc)).not.toContain("Propina sugerida");
  });

  it("con propina elegida (15 %): la sugerida es ésa, aparte y sin sumar", () => {
    const doc = build({ ...snapshot, suggestedTipPct: 15 });
    expect(doc.tipRows).toEqual([{ label: "Propina sugerida (voluntaria) 15%", amount: "$ 15,000" }]);
    expect(doc.totals.at(-1)).toEqual({ label: "TOTAL A PAGAR", amount: "$ 100,000", strong: true });
  });

  it("sin elección guardada (facturas anteriores, ficha de la mesa): la sugerida de siempre, 10 %", () => {
    expect(build(snapshot).tipRows).toEqual([{ label: "Propina sugerida (voluntaria) 10%", amount: "$ 10,000" }]);
  });
});
