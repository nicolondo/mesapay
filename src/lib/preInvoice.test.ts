// Factura ANTES de cobrar: emitir la factura de una cuenta abierta sin
// método de pago, mandarla a la DIAN ya y al papel cuando la acepta. Los
// mocks reemplazan la DB, la emisión, la cola y el correo; la orquestación
// (qué se emite, con qué adquiriente, cuándo sale papel) corre de verdad.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  orderFindUnique: vi.fn(),
  orderUpdateMany: vi.fn(),
  requestFindFirst: vi.fn(),
  dianDocFindUnique: vi.fn(),
  invoiceFindUnique: vi.fn(),
  resolveEmisor: vi.fn(),
  dianEnvironment: vi.fn(),
  ensureDianDocument: vi.fn(),
  emitDianInvoice: vi.fn(),
  deliverInvoiceEmail: vi.fn(),
  sync: vi.fn(),
  issueSimpleInvoice: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    order: { findUnique: m.orderFindUnique, updateMany: m.orderUpdateMany },
    invoiceRequest: { findFirst: m.requestFindFirst },
    dianDocument: { findUnique: m.dianDocFindUnique },
    simpleInvoice: { findUnique: m.invoiceFindUnique },
  },
}));
vi.mock("@/lib/dian/config", () => ({
  resolveEmisor: m.resolveEmisor,
  dianEnvironment: m.dianEnvironment,
}));
vi.mock("@/lib/dian/crypto", () => ({ dianQrUrl: (cufe: string) => `https://dian.test/${cufe}` }));
vi.mock("@/lib/dian/emit", () => ({ ensureDianDocument: m.ensureDianDocument }));
vi.mock("@/lib/dian/emitInvoice", () => ({ emitDianInvoice: m.emitDianInvoice }));
vi.mock("@/lib/invoiceDelivery", () => ({ deliverInvoiceEmail: m.deliverInvoiceEmail }));
vi.mock("@/lib/invoiceOnPaid", () => ({
  isBillableOrder: (o: { compedAt: Date | null; subtotalCents: number }) =>
    o.compedAt == null && o.subtotalCents > 0,
  numberingExhausted: (e: { resolutionTo: number | null; invoiceNextNumber: number } | null) =>
    !!e && e.resolutionTo != null && e.invoiceNextNumber > e.resolutionTo,
}));
vi.mock("@/lib/modules", () => ({
  isModuleEnabled: (mods: unknown, slug: string) => Array.isArray(mods) && mods.includes(slug),
}));
vi.mock("@/lib/orderTotals", () => ({ syncOrderSubtotalFromLiveItems: m.sync }));
vi.mock("@/lib/simpleInvoice", () => ({ issueSimpleInvoice: m.issueSimpleInvoice }));
vi.mock("@/lib/print/invoiceQueue", () => ({ enqueueInvoicePrintDetailed: m.enqueue }));

import { dianStatusOf, preInvoiceStatus, preIssueInvoice } from "./preInvoice";

const SNAP = { restaurantName: "Son y Melona", invoicePrefix: "FESM", issuedBeforePayment: true };

function order(over: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    restaurantId: "rest-1",
    status: "served",
    compedAt: null,
    simpleInvoiceEmail: null,
    simpleInvoice: null,
    restaurant: { enabledModules: [] as string[] },
    ...over,
  };
}

const call = () => preIssueInvoice({ restaurantId: "rest-1", orderId: "order-1" });

beforeEach(() => {
  vi.resetAllMocks();
  m.orderFindUnique.mockResolvedValue(order());
  m.orderUpdateMany.mockResolvedValue({ count: 1 });
  m.requestFindFirst.mockResolvedValue(null);
  m.sync.mockResolvedValue({ subtotalCents: 100_000_00, totalCents: 100_000_00, changed: false });
  m.resolveEmisor.mockResolvedValue({ resolutionTo: 10000, invoiceNextNumber: 6490 });
  m.dianEnvironment.mockResolvedValue("produccion");
  m.issueSimpleInvoice.mockResolvedValue({
    ok: true,
    invoiceId: "inv-1",
    invoiceUrl: "https://mesapay.co/factura/inv-1",
    invoiceNumber: 6490,
    snapshot: SNAP,
    email: null,
    locale: "es",
    alreadyIssued: false,
  });
  m.deliverInvoiceEmail.mockResolvedValue({ sent: "none", reason: "no_email" });
  m.invoiceFindUnique.mockResolvedValue({
    id: "inv-1",
    restaurantId: "rest-1",
    orderId: "order-1",
    invoiceNumber: 6490,
    snapshot: SNAP,
    order: { locale: "es" },
  });
  m.enqueue.mockResolvedValue({ queued: true, jobs: 1, printerNames: ["Caja"] });
  m.ensureDianDocument.mockResolvedValue({ id: "doc-1", state: "to_send", attempts: 0, created: true });
  m.emitDianInvoice.mockResolvedValue({
    outcome: "accepted",
    documentId: "doc-1",
    cufe: "CUFE-1",
    qrUrl: "q",
    errors: [],
    statusMessage: null,
  });
  m.dianDocFindUnique.mockResolvedValue({ state: "accepted", cufe: "CUFE-1", lastError: null });
});

describe("preIssueInvoice — sin facturación electrónica (comprobante)", () => {
  it("emite sobre la cuenta abierta (beforePayment) a consumidor final y la manda a la impresora", async () => {
    const r = await call();
    expect(r).toEqual({
      ok: true,
      invoiceId: "inv-1",
      documentNumber: "FESM6490",
      alreadyIssued: false,
      einvoicing: false,
      dian: null,
      print: { queued: true, printerName: "Caja" },
    });
    expect(m.issueSimpleInvoice).toHaveBeenCalledWith({
      tenantId: "rest-1",
      orderId: "order-1",
      email: null,
      beforePayment: true,
      customer: null,
    });
    // Queda constancia de "pidieron la genérica" (sin correo), sin pisar nada.
    expect(m.orderUpdateMany).toHaveBeenCalledWith({
      where: { id: "order-1", simpleInvoiceEmail: null },
      data: { simpleInvoiceEmail: "" },
    });
    // Papel: pedido humano, con la clave de la factura y sólo si el agente responde.
    expect(m.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "inv-1", trigger: "pre_issue", requireReachable: true }),
    );
    expect(m.enqueue.mock.calls[0][0]).not.toHaveProperty("dian");
    expect(m.emitDianInvoice).not.toHaveBeenCalled();
  });

  it("con factura personalizada pedida en la cuenta: sale a nombre del cliente y con su correo", async () => {
    m.requestFindFirst.mockResolvedValue({
      customerName: "ACME S.A.S.",
      docType: "NIT",
      docNumber: "901944469",
      address: null,
      city: null,
      department: null,
      email: "compras@acme.co",
    });
    await call();
    expect(m.issueSimpleInvoice).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "compras@acme.co",
        customer: expect.objectContaining({ name: "ACME S.A.S.", docType: "NIT", docNumber: "901944469" }),
      }),
    );
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("sin impresora (o con el agente caído): lo dice, para que la pantalla imprima desde el navegador", async () => {
    m.enqueue.mockResolvedValue({ queued: false, reason: "no_printer" });
    expect(await call()).toMatchObject({ ok: true, print: { queued: false, reason: "no_printer" } });
  });

  it("idempotente: la segunda vez devuelve la misma factura y la cola no saca otra copia", async () => {
    m.orderFindUnique.mockResolvedValue(order({ simpleInvoice: { id: "inv-1" }, simpleInvoiceEmail: "" }));
    m.issueSimpleInvoice.mockResolvedValue({
      ...(await m.issueSimpleInvoice()),
      alreadyIssued: true,
    });
    m.enqueue.mockResolvedValue({ queued: false, reason: "duplicate" });
    const r = await call();
    expect(r).toMatchObject({ ok: true, alreadyIssued: true, print: { queued: false, reason: "duplicate" } });
    expect(m.sync).not.toHaveBeenCalled();
    expect(m.deliverInvoiceEmail).not.toHaveBeenCalled();
  });
});

describe("preIssueInvoice — con facturación electrónica", () => {
  beforeEach(() => {
    m.orderFindUnique.mockResolvedValue(order({ restaurant: { enabledModules: ["einvoicing"] } }));
  });

  it("la emite YA (sin que la emisión imprima) y, aceptada, sale la factura electrónica con su CUFE", async () => {
    const r = await call();
    expect(r).toMatchObject({ ok: true, einvoicing: true, dian: { state: "accepted" }, print: { queued: true } });
    expect(m.emitDianInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ simpleInvoiceId: "inv-1", restaurantId: "rest-1", printOnAccept: false }),
    );
    expect(m.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "pre_issue",
        dian: { cufe: "CUFE-1", qrUrl: "https://dian.test/CUFE-1" },
      }),
    );
  });

  it("si la DIAN no responde todavía: no imprime nada (sale sola al aceptarla) y lo dice", async () => {
    m.emitDianInvoice.mockResolvedValue({
      outcome: "pending",
      documentId: "doc-1",
      cufe: null,
      qrUrl: null,
      errors: [],
      statusMessage: null,
    });
    const r = await call();
    expect(r).toMatchObject({ ok: true, dian: { state: "pending" }, print: { queued: false, reason: "waiting_dian" } });
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("frenada por configuración: queda numerada y en cola, con el motivo", async () => {
    m.emitDianInvoice.mockResolvedValue({ outcome: "blocked", reason: "resolution_incomplete", missing: [] });
    const r = await call();
    expect(r).toMatchObject({ dian: { state: "blocked", reason: "resolution_incomplete" }, print: { reason: "waiting_dian" } });
  });

  it("sin números en la resolución no se emite nada", async () => {
    m.resolveEmisor.mockResolvedValue({ resolutionTo: 10000, invoiceNextNumber: 10001 });
    expect(await call()).toEqual({ ok: false, error: "numbering_exhausted" });
    expect(m.issueSimpleInvoice).not.toHaveBeenCalled();
  });

  it("un documento que ya está en manos de la DIAN no se vuelve a emitir: se lee su estado", async () => {
    m.orderFindUnique.mockResolvedValue(
      order({ restaurant: { enabledModules: ["einvoicing"] }, simpleInvoice: { id: "inv-1" } }),
    );
    m.ensureDianDocument.mockResolvedValue({ id: "doc-1", state: "pending", attempts: 1, created: false });
    m.dianDocFindUnique.mockResolvedValue({ state: "pending", cufe: null, lastError: null });
    const r = await call();
    expect(m.emitDianInvoice).not.toHaveBeenCalled();
    expect(r).toMatchObject({ dian: { state: "pending" } });
  });
});

describe("preIssueInvoice — lo que no se factura", () => {
  it.each(["paid", "cancelled"])("una cuenta %s: order_closed", async (status) => {
    m.orderFindUnique.mockResolvedValue(order({ status }));
    expect(await call()).toEqual({ ok: false, error: "order_closed" });
  });

  it("una cuenta en $0 o una cortesía no es una venta", async () => {
    m.sync.mockResolvedValue({ subtotalCents: 0, totalCents: 0, changed: false });
    expect(await call()).toEqual({ ok: false, error: "not_billable" });
    m.sync.mockResolvedValue({ subtotalCents: 100, totalCents: 100, changed: false });
    m.orderFindUnique.mockResolvedValue(order({ compedAt: new Date() }));
    expect(await call()).toEqual({ ok: false, error: "not_billable" });
  });

  it("la cuenta de otro comercio no existe", async () => {
    m.orderFindUnique.mockResolvedValue(order({ restaurantId: "otro" }));
    expect(await call()).toEqual({ ok: false, error: "not_found" });
  });
});

describe("estado DIAN para la pantalla", () => {
  it.each([
    [{ state: "accepted", lastError: null }, { state: "accepted" }],
    [{ state: "to_send", lastError: null }, { state: "pending" }],
    [{ state: "to_send", lastError: "contact_email_incomplete" }, { state: "blocked", reason: "contact_email_incomplete" }],
    [{ state: "sent", lastError: null }, { state: "pending" }],
    [{ state: "pending", lastError: null }, { state: "pending" }],
    [{ state: "rejected", lastError: "FAK24" }, { state: "rejected", reason: "FAK24" }],
    [{ state: "error", lastError: "timeout" }, { state: "error", reason: "timeout" }],
  ])("%o → %o", (doc, expected) => {
    expect(dianStatusOf(doc)).toEqual(expected);
  });

  it("preInvoiceStatus: número, estado DIAN y si ya se pagó, sin emitir nada", async () => {
    m.orderFindUnique.mockResolvedValue({
      restaurantId: "rest-1",
      status: "paying",
      restaurant: { enabledModules: ["einvoicing"] },
      simpleInvoice: {
        id: "inv-1",
        invoiceNumber: 6490,
        snapshot: SNAP,
        dianDocument: { state: "accepted", lastError: null },
      },
    });
    expect(await preInvoiceStatus({ restaurantId: "rest-1", orderId: "order-1" })).toEqual({
      ok: true,
      invoiceId: "inv-1",
      documentNumber: "FESM6490",
      einvoicing: true,
      dian: { state: "accepted" },
      paid: false,
    });
    expect(m.emitDianInvoice).not.toHaveBeenCalled();
  });
});
