// La tirilla CONGELA la tarifa del comercio al emitirse. De este snapshot
// leen después el XML de la DIAN y la contabilidad, así que cambiar la
// tarifa mañana no toca lo emitido hoy.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  orderFindUnique: vi.fn(),
  restaurantUpdate: vi.fn(),
  invoiceCreate: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    order: { findUnique: m.orderFindUnique },
    restaurant: { update: m.restaurantUpdate },
    simpleInvoice: { create: m.invoiceCreate },
  },
}));
vi.mock("@/lib/env", () => ({ env: { APP_PUBLIC_BASE_URL: "https://mesapay.co" } }));
vi.mock("@/lib/mailer", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/print/invoiceQueue", () => ({ enqueueInvoicePrintSafe: m.enqueue }));

import { issueSimpleInvoice } from "./simpleInvoice";
import type { InvoiceSnapshot } from "./invoice";

function order() {
  return {
    id: "order-1",
    restaurantId: "rest-1",
    status: "paid",
    shortCode: "A4F2",
    locale: "es",
    paidAt: new Date("2026-09-14T20:00:00.000Z"),
    table: { number: 7, label: null },
    simpleInvoice: null,
    items: [
      // Plato del menú: impuesto embebido con la tarifa del comercio.
      { qty: 1, nameSnapshot: "Bandeja paisa", priceCentsSnapshot: 3_000_000, taxKind: null, taxPct: null, cancelledAt: null },
      // Línea libre: IVA 19% SUMADO encima, no embebido.
      { qty: 1, nameSnapshot: "Servicio", priceCentsSnapshot: 1_000_000, taxKind: "iva", taxPct: 19, cancelledAt: null },
    ],
    subtotalCents: 4_000_000,
    taxCents: 190_000,
    discountCents: 0,
    discountPct: null,
    tipCents: 0,
    totalCents: 4_190_000,
  };
}

function restaurant(tax: { salesTaxKind: string; salesTaxPct: number }) {
  return {
    invoiceNextNumber: 43,
    name: "Son y Melona",
    logoUrl: null,
    legalName: "SON Y MELONA S.A.S.",
    taxId: "901944469-1",
    legalAddress: null,
    legalCity: null,
    legalPhone: null,
    dianResolution: null,
    dianResolutionNumber: "18764094877213",
    dianResolutionFrom: 1,
    dianResolutionTo: 10000,
    dianResolutionDate: null,
    invoicePrefix: "FESM",
    ...tax,
  };
}

async function issuedSnapshot(): Promise<InvoiceSnapshot> {
  const r = await issueSimpleInvoice({ tenantId: "rest-1", orderId: "order-1" });
  expect(r.ok).toBe(true);
  const created = m.invoiceCreate.mock.calls[0][0] as { data: { snapshot: InvoiceSnapshot } };
  return created.data.snapshot;
}

beforeEach(() => {
  vi.resetAllMocks();
  m.orderFindUnique.mockResolvedValue(order());
  m.invoiceCreate.mockResolvedValue({ id: "inv-1" });
  m.enqueue.mockResolvedValue(undefined);
});

describe("issueSimpleInvoice — impuesto congelado en el snapshot", () => {
  it("con el comercio en INC 8% guarda la tarifa y el embebido de los platos (mismo reparto que el XML)", async () => {
    m.restaurantUpdate.mockResolvedValue(restaurant({ salesTaxKind: "inc", salesTaxPct: 8 }));
    const s = await issuedSnapshot();
    expect(s).toMatchObject({
      salesTaxKind: "inc",
      salesTaxPct: 8,
      // Bandeja de $30.000: base 27.777,78 + impoconsumo 2.222,22.
      embeddedTaxCents: 222_222,
      embeddedBaseCents: 2_777_778,
    });
    // Las líneas libres siguen aparte: su IVA va ENCIMA, en taxByKind.
    expect(s.taxCents).toBe(190_000);
    expect(s.taxByKind).toEqual({ inc: 0, iva: 190_000 });
    // El consecutivo pide la tarifa en la misma escritura atómica.
    const upd = m.restaurantUpdate.mock.calls[0][0] as { select: Record<string, boolean> };
    expect(upd.select.salesTaxKind).toBe(true);
    expect(upd.select.salesTaxPct).toBe(true);
  });

  it("con el comercio sin impuesto deja constancia explícita: none, cero, base = bruto", async () => {
    m.restaurantUpdate.mockResolvedValue(restaurant({ salesTaxKind: "none", salesTaxPct: 0 }));
    const s = await issuedSnapshot();
    expect(s).toMatchObject({
      salesTaxKind: "none",
      salesTaxPct: 0,
      embeddedTaxCents: 0,
      embeddedBaseCents: 3_000_000,
    });
  });

  it("'none' con un porcentaje suelto en la config se congela como 0", async () => {
    m.restaurantUpdate.mockResolvedValue(restaurant({ salesTaxKind: "none", salesTaxPct: 8 }));
    const s = await issuedSnapshot();
    expect(s.salesTaxPct).toBe(0);
    expect(s.embeddedTaxCents).toBe(0);
  });

  it("una factura ya emitida se devuelve tal cual, sin recalcular con la tarifa de hoy", async () => {
    const frozen = { salesTaxKind: "none", salesTaxPct: 0, embeddedTaxCents: 0, embeddedBaseCents: 3_000_000 };
    m.orderFindUnique.mockResolvedValue({
      ...order(),
      simpleInvoice: { id: "inv-0", invoiceNumber: 7, email: null, snapshot: { ...frozen, subtotalCents: 4_000_000 } },
    });
    m.restaurantUpdate.mockResolvedValue(restaurant({ salesTaxKind: "inc", salesTaxPct: 8 }));
    const r = await issueSimpleInvoice({ tenantId: "rest-1", orderId: "order-1" });
    expect(r.ok && r.alreadyIssued).toBe(true);
    expect(r.ok && r.snapshot).toMatchObject(frozen);
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
    expect(m.invoiceCreate).not.toHaveBeenCalled();
  });
});
