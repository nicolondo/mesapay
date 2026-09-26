import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La factura genérica pedida SIN correo, de punta a punta del cobro:
 * `issueInvoiceOnPaid` → `issueSimpleInvoice` (el real, no un mock) →
 * encolado en la impresora de facturas de la caja.
 *
 * El dueño: "si no se pone ningún correo en lo de la factura electrónica
 * genérica que igual se genere la factura para poderla imprimir". Acá se
 * blinda que, al cobrar, la factura se EMITE (se numera y se guarda sin
 * correo), se ENCOLA para imprimir y no se intenta mandar a nadie. Si el
 * papel sale o no lo decide la cola (`invoicePrintDecision`: impresión
 * automática, impresora configurada, o la aceptación de la DIAN con
 * facturación electrónica), que tiene sus propios tests en
 * `print/invoiceQueue.test.ts` y `print/routing.test.ts`.
 *
 * `invoiceOnPaid.test.ts` prueba la DECISIÓN con `issueSimpleInvoice`
 * mockeado; este archivo, que esa decisión termina en papel.
 */

const m = vi.hoisted(() => ({
  orderFindUnique: vi.fn(),
  requestFindFirst: vi.fn(),
  restaurantUpdate: vi.fn(),
  invoiceCreate: vi.fn(),
  dianDocumentFindUnique: vi.fn(),
  enqueueInvoicePrintSafe: vi.fn(),
  sendEmail: vi.fn(),
  resolveEmisor: vi.fn(),
  ensureDianDocument: vi.fn(),
  recordNumberingExhausted: vi.fn(),
  emitDianInvoice: vi.fn(),
}));

vi.mock("next/server", () => ({ after: (task: () => Promise<void>) => void task() }));
vi.mock("@/lib/env", () => ({ env: { APP_PUBLIC_BASE_URL: "https://mesapay.co" } }));
vi.mock("@/lib/db", () => ({
  db: {
    order: { findUnique: m.orderFindUnique },
    invoiceRequest: { findFirst: m.requestFindFirst },
    restaurant: { update: m.restaurantUpdate },
    simpleInvoice: { create: m.invoiceCreate },
    dianDocument: { findUnique: m.dianDocumentFindUnique },
  },
}));
vi.mock("@/lib/mailer", () => ({ sendEmail: m.sendEmail }));
vi.mock("@/lib/invoice", () => ({ renderInvoiceEmail: vi.fn() }));
vi.mock("@/lib/print/invoiceQueue", () => ({
  enqueueInvoicePrintSafe: m.enqueueInvoicePrintSafe,
}));
vi.mock("@/lib/dian/config", () => ({ resolveEmisor: m.resolveEmisor }));
vi.mock("@/lib/dian/emit", () => ({
  embeddedMenuTax: () => ({ taxCents: 0, baseCents: 0 }),
  ensureDianDocument: m.ensureDianDocument,
  recordNumberingExhausted: m.recordNumberingExhausted,
}));
vi.mock("@/lib/dian/emitInvoice", () => ({ emitDianInvoice: m.emitDianInvoice }));
vi.mock("@/lib/modules", () => ({
  isModuleEnabled: (mods: unknown, slug: string) =>
    Array.isArray(mods) && mods.includes(slug),
}));

import { issueInvoiceOnPaid } from "./invoiceOnPaid";

/**
 * Una sola fila sirve para las dos lecturas de la orden: el `select` de
 * `issueInvoiceOnPaid` y el `include` de `issueSimpleInvoice`.
 */
function orderRow(over: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    restaurantId: "rest-1",
    status: "paid",
    simpleInvoiceEmail: "",
    subtotalCents: 50_000_00,
    taxCents: 0,
    discountCents: 0,
    discountPct: null,
    tipCents: 0,
    totalCents: 50_000_00,
    compedAt: null,
    paidAt: new Date("2026-09-26T15:00:00Z"),
    shortCode: "ABC123",
    locale: "es",
    table: { kind: "table", number: 4, label: null },
    items: [
      {
        qty: 2,
        nameSnapshot: "Arepa",
        priceCentsSnapshot: 25_000_00,
        menuItemId: "mi-1",
        taxKind: null,
        taxPct: null,
        modifierSelections: null,
        menuItem: { modifiers: null },
        notes: null,
      },
    ],
    simpleInvoice: null,
    restaurant: { enabledModules: [] as string[] },
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  m.orderFindUnique.mockResolvedValue(orderRow());
  m.requestFindFirst.mockResolvedValue(null);
  m.restaurantUpdate.mockResolvedValue({
    invoiceNextNumber: 8,
    name: "Donde Chucho",
    logoUrl: null,
    legalName: null,
    taxId: null,
    legalAddress: null,
    legalCity: null,
    legalPhone: null,
    dianResolution: null,
    dianResolutionNumber: null,
    dianResolutionFrom: null,
    dianResolutionTo: null,
    dianResolutionDate: null,
    invoicePrefix: "POS",
    salesTaxKind: "none",
    salesTaxPct: 0,
  });
  m.invoiceCreate.mockResolvedValue({ id: "inv-1" });
  m.enqueueInvoicePrintSafe.mockResolvedValue(1);
  m.resolveEmisor.mockResolvedValue({ resolutionTo: 10000, invoiceNextNumber: 8 });
  m.ensureDianDocument.mockResolvedValue({
    id: "doc-1",
    state: "to_send",
    attempts: 0,
    created: true,
  });
  m.emitDianInvoice.mockResolvedValue({ outcome: "accepted", documentId: "doc-1" });
});

const call = () =>
  issueInvoiceOnPaid({ tenantId: "rest-1", orderId: "order-1", emit: "inline" });

describe("genérica pedida SIN correo — al cobrar se emite y se encola para imprimir", () => {
  it("sin facturación electrónica: tirilla numerada, sin correo, encolada al cobrar", async () => {
    const r = await call();
    expect(r).toEqual({ status: "issued", invoiceId: "inv-1", alreadyIssued: false, emit: null });

    // Emitida y numerada, sin correo.
    expect(m.invoiceCreate).toHaveBeenCalledTimes(1);
    expect(m.invoiceCreate.mock.calls[0][0].data).toMatchObject({
      restaurantId: "rest-1",
      orderId: "order-1",
      email: null,
      invoiceNumber: 7,
      totalCents: 50_000_00,
    });

    // A la impresora de la caja, con el disparo del cobro.
    expect(m.enqueueInvoicePrintSafe).toHaveBeenCalledTimes(1);
    expect(m.enqueueInvoicePrintSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        restaurantId: "rest-1",
        orderId: "order-1",
        invoiceId: "inv-1",
        invoiceNumber: 7,
        locale: "es",
        trigger: "paid",
      }),
    );

    // Nadie a quién mandarla: no se intenta ningún correo.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.ensureDianDocument).not.toHaveBeenCalled();
  });

  it("con facturación electrónica: tirilla + documento DIAN a consumidor final, sin correo", async () => {
    m.orderFindUnique.mockResolvedValue(
      orderRow({ restaurant: { enabledModules: ["einvoicing"] } }),
    );
    const r = await call();
    expect(r).toMatchObject({ status: "issued", invoiceId: "inv-1" });
    expect(m.invoiceCreate.mock.calls[0][0].data).toMatchObject({ email: null });
    // Se encola igual; con `einvoicing` la cola no imprime al cobrar sino
    // al aceptarla la DIAN (#490) — esa regla es de `invoicePrintDecision`.
    expect(m.enqueueInvoicePrintSafe).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "inv-1", trigger: "paid" }),
    );
    expect(m.ensureDianDocument).toHaveBeenCalledTimes(1);
    expect(m.emitDianInvoice).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(m.sendEmail).not.toHaveBeenCalled();
    // Sin correo ni siquiera se busca el documento para mandarlo.
    expect(m.dianDocumentFindUnique).not.toHaveBeenCalled();
  });

  it("ya emitida (dos rieles): no re-numera y reintenta el encolado, que la cola deduplica", async () => {
    m.orderFindUnique.mockResolvedValue(
      orderRow({
        simpleInvoice: {
          id: "inv-1",
          restaurantId: "rest-1",
          orderId: "order-1",
          invoiceNumber: 7,
          email: null,
          snapshot: { restaurantName: "Donde Chucho" },
        },
      }),
    );
    const r = await call();
    expect(r).toMatchObject({ status: "issued", alreadyIssued: true });
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
    expect(m.invoiceCreate).not.toHaveBeenCalled();
    expect(m.enqueueInvoicePrintSafe).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "inv-1", trigger: "paid" }),
    );
  });

  it("sin facturación electrónica y sin pedido (null), como siempre: nada que imprimir", async () => {
    m.orderFindUnique.mockResolvedValue(orderRow({ simpleInvoiceEmail: null }));
    const r = await call();
    expect(r).toEqual({ status: "skipped", reason: "not_requested" });
    expect(m.invoiceCreate).not.toHaveBeenCalled();
    expect(m.enqueueInvoicePrintSafe).not.toHaveBeenCalled();
  });
});
