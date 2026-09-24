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

  it("una factura manual armada con un cargo 'impuesto incluido' congela el MISMO impoconsumo que ese valor en platos de una mesa", async () => {
    m.restaurantUpdate.mockResolvedValue(restaurant({ salesTaxKind: "inc", salesTaxPct: 8 }));
    // Mesa: bandeja de $30.000 del menú.
    const dish = { qty: 1, nameSnapshot: "Bandeja paisa", priceCentsSnapshot: 3_000_000, taxKind: null, taxPct: null, cancelledAt: null };
    m.orderFindUnique.mockResolvedValue({ ...order(), items: [dish], subtotalCents: 3_000_000, taxCents: 0, totalCents: 3_000_000 });
    const table = await issuedSnapshot();
    vi.resetAllMocks();
    m.invoiceCreate.mockResolvedValue({ id: "inv-2" });
    m.enqueue.mockResolvedValue(undefined);
    m.restaurantUpdate.mockResolvedValue(restaurant({ salesTaxKind: "inc", salesTaxPct: 8 }));
    // Factura manual: el mismo valor como línea libre con el impuesto incluido
    // (sin ronda, sin plato del menú, `taxKind` null).
    const charge = { qty: 1, nameSnapshot: "Almuerzos evento", priceCentsSnapshot: 3_000_000, taxKind: null, taxPct: null, cancelledAt: null, roundId: null, menuItemId: null };
    m.orderFindUnique.mockResolvedValue({
      ...order(),
      table: { number: -100, label: "Factura manual", kind: "manual" },
      items: [charge],
      subtotalCents: 3_000_000,
      taxCents: 0,
      totalCents: 3_000_000,
    });
    const manual = await issuedSnapshot();
    expect(manual.tableLabel).toBe("Factura manual");
    // Misma línea de impuesto: base 27.777,78 + impoconsumo 2.222,22 incluido; nada encima.
    for (const s of [table, manual]) {
      expect(s).toMatchObject({ salesTaxKind: "inc", salesTaxPct: 8, embeddedTaxCents: 222_222, embeddedBaseCents: 2_777_778, taxCents: 0, totalCents: 3_000_000 });
      expect(s.taxByKind).toEqual({ inc: 0, iva: 0 });
    }
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

describe("issueSimpleInvoice — lo que distingue a dos líneas al agruparlas", () => {
  it("guarda referencia del plato, impuesto, modificadores LEGIBLES y nota; sin tocar nombre ni precio", async () => {
    const termino = {
      id: "mod-1",
      label: "Término",
      type: "radio",
      opts: [{ label: "Medio" }, { label: "Bien asado" }],
    };
    m.orderFindUnique.mockResolvedValue({
      ...order(),
      items: [
        {
          qty: 2,
          nameSnapshot: "Hamburguesa",
          priceCentsSnapshot: 2_800_000,
          menuItemId: "mi-hamburguesa",
          taxKind: null,
          taxPct: null,
          modifierSelections: { "mod-1": "Medio" },
          menuItem: { modifiers: [termino] },
          notes: "  sin cebolla ",
          cancelledAt: null,
        },
        {
          qty: 1,
          nameSnapshot: "Servicio",
          priceCentsSnapshot: 1_000_000,
          menuItemId: null,
          taxKind: "iva",
          taxPct: 19,
          modifierSelections: null,
          menuItem: null,
          notes: "   ",
          cancelledAt: null,
        },
      ],
    });
    m.restaurantUpdate.mockResolvedValue(restaurant({ salesTaxKind: "none", salesTaxPct: 0 }));
    const s = await issuedSnapshot();
    expect(s.items).toEqual([
      {
        qty: 2,
        name: "Hamburguesa",
        priceCents: 2_800_000,
        menuItemId: "mi-hamburguesa",
        taxKind: null,
        taxPct: null,
        modifiers: ["Término: Medio"],
        notes: "sin cebolla",
      },
      {
        qty: 1,
        name: "Servicio",
        priceCents: 1_000_000,
        menuItemId: null,
        taxKind: "iva",
        taxPct: 19,
        modifiers: [],
        notes: null,
      },
    ]);
    // Los modificadores se nombran con la definición del plato: la query
    // la trae junto con los ítems.
    const q = m.orderFindUnique.mock.calls[0][0] as {
      include: { items: { include: { menuItem: { select: { modifiers: boolean } } } } };
    };
    expect(q.include.items.include.menuItem.select.modifiers).toBe(true);
  });
});
