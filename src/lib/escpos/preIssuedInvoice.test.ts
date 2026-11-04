// Factura emitida ANTES de cobrar: el papel que se le lleva a la mesa.
// "Pendiente de pago" en vez de la forma de pago, y la propina sugerida
// con el TOTAL CON PROPINA de la precuenta (esta hoja la reemplaza). Una
// vez cobrada, la reimpresión muestra lo cobrado y la propina que dejaron.
import { describe, expect, it } from "vitest";
import { readPaper } from "./testPaper";
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
  key === "prebillSuggestedTip" ? `Propina sugerida ${values?.pct}%` : (LABELS[key] ?? key);
const money = (cents: number) => `$ ${Math.round(cents / 100).toLocaleString("es-CO")}`;

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

const build = (snap: InvoiceSnapshot, payments: InvoicePaymentLine[] = [], dian = false) =>
  buildThermalInvoice({
    snapshot: snap,
    invoiceNumber: 6490,
    paperWidthMm: 80,
    paidAtLabel: "4/11/26, 18:10",
    dianResolutionDateLabel: null,
    payments,
    money,
    t,
    dian: dian ? { cufe: "c".repeat(96), verifyUrl: "https://catalogo-vpfe.dian.gov.co/x", qr: false } : null,
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
      totalWithTipCents: 11_000_000,
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
  it("sin pagos: 'Pendiente de pago' en vez de la forma de pago + propina sugerida y TOTAL CON PROPINA", () => {
    const doc = build(snapshot);
    expect(doc.paymentTitle).toBeNull();
    expect(doc.paymentRows).toEqual([]);
    expect(doc.pendingRow).toEqual({ label: "Pendiente de pago", amount: "$ 100.000", strong: true });
    expect(doc.tipRows).toEqual([
      { label: "Propina sugerida 10%", amount: "$ 10.000" },
      { label: "TOTAL CON PROPINA", amount: "$ 110.000", strong: true },
    ]);
    expect(doc.tipNotice).toBe(LABELS.prebillTipVoluntary);
    const text = paper(doc);
    expect(text).toContain("Pendiente de pago");
    expect(text).toContain("Propina sugerida 10%");
    expect(text).toContain("TOTAL CON PROPINA");
    expect(text).toContain("La propina es voluntaria");
    expect(text).not.toContain("Forma de pago");
    // El TOTAL de la factura es la venta: la propina sugerida NO está sumada.
    expect(text).toMatch(/TOTAL +\$ 100\.000/);
  });

  it("como factura electrónica aceptada lleva el CUFE y también el 'Pendiente de pago'", () => {
    const text = paper(build(snapshot, [], true));
    expect(text).toContain("FACTURA ELECTRÓNICA DE VENTA");
    expect(text).toContain("CUFE:");
    expect(text).toContain("Pendiente de pago");
  });

  it("con un pago parcial (cuenta dividida): lo cobrado por método, sin su propina, y lo que falta", () => {
    const doc = build(snapshot, [{ method: "cash", amountCents: 5_500_000, tipCents: 500_000 }]);
    expect(doc.paymentRows).toEqual([
      { label: "Efectivo", amount: "$ 50.000" },
      { label: "Propina", amount: "$ 5.000" },
    ]);
    expect(doc.pendingRow).toEqual({ label: "Pendiente de pago", amount: "$ 50.000", strong: true });
    expect(doc.tipRows?.[0]).toEqual({ label: "Propina sugerida 10%", amount: "$ 5.000" });
  });

  it("reimpresa ya cobrada: la forma de pago suma el TOTAL, la propina aparte, y ya no hay pendiente ni sugerida", () => {
    const doc = build(snapshot, [
      { method: "cash", amountCents: 6_000_000, tipCents: 0 },
      { method: "kushki_card_terminal", amountCents: 4_800_000, tipCents: 800_000 },
    ]);
    expect(doc.paymentRows).toEqual([
      { label: "Efectivo", amount: "$ 60.000" },
      { label: "Tarjeta · datáfono", amount: "$ 40.000" },
      { label: "Propina", amount: "$ 8.000" },
    ]);
    expect(doc.pendingRow).toBeNull();
    expect(doc.tipRows).toEqual([]);
    expect(paper(doc)).not.toContain("Pendiente de pago");
  });

  it("una factura emitida al cobrar se imprime igual que siempre (sin los campos nuevos)", () => {
    const doc = build({ ...snapshot, issuedBeforePayment: undefined }, [
      { method: "cash", amountCents: 11_000_000, tipCents: 1_000_000 },
    ]);
    expect("pendingRow" in doc).toBe(false);
    expect("tipRows" in doc).toBe(false);
    expect(doc.paymentRows).toEqual([{ label: "Efectivo", amount: "$ 110.000" }]);
  });

  it("el payload guardado en la cola conserva el pendiente y la propina sugerida", () => {
    const doc = build(snapshot);
    const parsed = parseInvoicePayload(JSON.parse(JSON.stringify({ v: INVOICE_PAYLOAD_VERSION, invoice: doc })));
    expect(parsed?.pendingRow).toEqual(doc.pendingRow);
    expect(parsed?.tipRows).toEqual(doc.tipRows);
    expect(parsed?.tipNotice).toBe(doc.tipNotice);
    expect(renderInvoice(parsed!).equals(renderInvoice(doc))).toBe(true);
  });

  it("en 58 mm también entra todo (sin renglones partidos en el pendiente)", () => {
    const doc = { ...build(snapshot), paperWidthMm: 58 };
    const text = paper(doc);
    expect(text).toContain("Pendiente de pago");
    expect(text).toContain("TOTAL CON PROPINA");
  });
});
