// La tirilla CONGELA la tarifa del comercio al emitirse. De este snapshot
// leen después el XML de la DIAN y la contabilidad, así que cambiar la
// tarifa mañana no toca lo emitido hoy.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  orderFindUnique: vi.fn(),
  restaurantUpdate: vi.fn(),
  invoiceCreate: vi.fn(),
  invoiceFindUnique: vi.fn(),
  invoiceUpdate: vi.fn(async () => ({})),
  sendEmail: vi.fn(async () => true),
  enqueue: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    order: { findUnique: m.orderFindUnique },
    restaurant: { update: m.restaurantUpdate },
    simpleInvoice: { create: m.invoiceCreate, findUnique: m.invoiceFindUnique, update: m.invoiceUpdate },
  },
}));
vi.mock("@/lib/env", () => ({ env: { APP_PUBLIC_BASE_URL: "https://mesapay.co" } }));
vi.mock("@/lib/mailer", () => ({ sendEmail: m.sendEmail }));
vi.mock("@/lib/print/invoiceQueue", () => ({ enqueueInvoicePrintSafe: m.enqueue }));

import { issueSimpleInvoice, sendSimpleInvoiceEmail } from "./simpleInvoice";
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
      // Bandeja de $30,000: base 27.777,78 + impoconsumo 2.222,22.
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
    // Mesa: bandeja de $30,000 del menú.
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


describe("invoice sale timestamp", () => {
  it("freezes final payment time even when the table was opened the previous day", async () => {
    m.restaurantUpdate.mockResolvedValue(restaurant({ salesTaxKind: "none", salesTaxPct: 0 }));
    m.orderFindUnique.mockResolvedValue({ ...order(), createdAt: new Date("2026-09-13T13:00:00Z") });
    const snapshot = await issuedSnapshot();
    expect(snapshot.paidAtIso).toBe("2026-09-14T20:00:00.000Z");
  });
});

describe("issueSimpleInvoice — factura ANTES de cobrar (beforePayment)", () => {
  const openOrder = () => ({
    ...order(),
    status: "served",
    paidAt: null,
    items: order().items.map((i, n) => ({ ...i, id: `it-${n + 1}` })),
  });

  it("sobre una cuenta abierta: numera, congela los ítems y NO encola papel (lo imprime quien la pidió)", async () => {
    m.orderFindUnique.mockResolvedValue(openOrder());
    m.restaurantUpdate.mockResolvedValue(restaurant({ salesTaxKind: "inc", salesTaxPct: 8 }));
    const before = Date.now();
    const r = await issueSimpleInvoice({ tenantId: "rest-1", orderId: "order-1", beforePayment: true });
    expect(r).toMatchObject({ ok: true, invoiceNumber: 42, alreadyIssued: false });
    const snap = (m.invoiceCreate.mock.calls[0][0] as { data: { snapshot: InvoiceSnapshot } }).data.snapshot;
    expect(snap.issuedBeforePayment).toBe(true);
    expect(snap.orderItemIds).toEqual(["it-1", "it-2"]);
    // Sin `paidAt`: la fecha de la factura es la de la emisión.
    expect(Date.parse(snap.paidAtIso)).toBeGreaterThanOrEqual(before - 1000);
    // La venta (sin propina) es el total de la factura, igual que siempre.
    expect(snap.totalCents).toBe(4_190_000);
    expect(snap.tipCents).toBe(0);
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("sin pedirlo explícitamente, una cuenta sin pagar sigue sin factura (order_not_paid)", async () => {
    m.orderFindUnique.mockResolvedValue(openOrder());
    const r = await issueSimpleInvoice({ tenantId: "rest-1", orderId: "order-1" });
    expect(r).toEqual({ ok: false, error: "order_not_paid" });
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
  });

  it("con un pago parcial que dejó propina, la factura es la VENTA: sin esa propina", async () => {
    // Una parte de la mesa ya pagó $1,000,000 + $100,000 de propina: la
    // orden lleva tipCents y totalCents con esa propina. La factura no.
    m.orderFindUnique.mockResolvedValue({ ...openOrder(), status: "paying", tipCents: 100_000, totalCents: 4_290_000 });
    m.restaurantUpdate.mockResolvedValue(restaurant({ salesTaxKind: "inc", salesTaxPct: 8 }));
    await issueSimpleInvoice({ tenantId: "rest-1", orderId: "order-1", beforePayment: true });
    const data = (m.invoiceCreate.mock.calls[0][0] as { data: { snapshot: InvoiceSnapshot; totalCents: number } }).data;
    expect(data.snapshot.tipCents).toBe(0);
    expect(data.snapshot.totalCents).toBe(4_190_000);
    expect(data.totalCents).toBe(4_190_000);
  });

  it("una cuenta cancelada no se factura", async () => {
    m.orderFindUnique.mockResolvedValue({ ...openOrder(), status: "cancelled" });
    const r = await issueSimpleInvoice({ tenantId: "rest-1", orderId: "order-1", beforePayment: true });
    expect(r).toEqual({ ok: false, error: "order_closed" });
  });

  it("al cobrar después, el riel del cobro encuentra ESA factura: ni otro número ni otra hoja", async () => {
    m.orderFindUnique.mockResolvedValue({
      ...order(),
      simpleInvoice: {
        id: "inv-pre",
        restaurantId: "rest-1",
        orderId: "order-1",
        invoiceNumber: 41,
        email: null,
        snapshot: { restaurantName: "Son y Melona", issuedBeforePayment: true },
      },
    });
    const r = await issueSimpleInvoice({ tenantId: "rest-1", orderId: "order-1" });
    expect(r).toMatchObject({ ok: true, invoiceId: "inv-pre", invoiceNumber: 41, alreadyIssued: true });
    expect(m.restaurantUpdate).not.toHaveBeenCalled();
    expect(m.invoiceCreate).not.toHaveBeenCalled();
    expect(m.enqueue).not.toHaveBeenCalled();
  });

  it("una factura emitida al cobrar sí reintenta el encolado (comportamiento de siempre)", async () => {
    m.orderFindUnique.mockResolvedValue({
      ...order(),
      simpleInvoice: {
        id: "inv-1",
        restaurantId: "rest-1",
        orderId: "order-1",
        invoiceNumber: 41,
        email: null,
        snapshot: { restaurantName: "Son y Melona" },
      },
    });
    await issueSimpleInvoice({ tenantId: "rest-1", orderId: "order-1" });
    expect(m.enqueue).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: "inv-1", trigger: "paid" }));
  });

  it("carrera (el cobro y la emisión a la vez): el segundo choca con el único y devuelve la del primero", async () => {
    m.orderFindUnique.mockResolvedValue(openOrder());
    m.restaurantUpdate.mockResolvedValue(restaurant({ salesTaxKind: "inc", salesTaxPct: 8 }));
    m.invoiceCreate.mockRejectedValue(Object.assign(new Error("Unique constraint"), { code: "P2002" }));
    m.invoiceFindUnique.mockResolvedValue({
      id: "inv-winner",
      invoiceNumber: 41,
      email: null,
      snapshot: { restaurantName: "Son y Melona" },
    });
    const r = await issueSimpleInvoice({ tenantId: "rest-1", orderId: "order-1", beforePayment: true });
    expect(r).toMatchObject({ ok: true, invoiceId: "inv-winner", invoiceNumber: 41, alreadyIssued: true });
    expect(m.enqueue).not.toHaveBeenCalled();
  });
});

describe("issueSimpleInvoice — descuento del cliente dentro de las líneas", () => {
  // Cuenta de menú con INC 8 % incluido y 20 % de descuento del cliente: la
  // tirilla congela la base y el impuesto NETOS (lo que declara el XML) y
  // deja la marca `discountInLines`. Sin descuento, ni marca ni cambio.
  const items = [
    { qty: 1, nameSnapshot: "Bandeja paisa", priceCentsSnapshot: 4_200_000, taxKind: null, taxPct: null, cancelledAt: null },
    { qty: 2, nameSnapshot: "Limonada", priceCentsSnapshot: 1_200_000, taxKind: null, taxPct: null, cancelledAt: null },
  ];

  it("congela el impuesto embebido sobre lo cobrado y la marca del descuento en las líneas", async () => {
    m.restaurantUpdate.mockResolvedValue(restaurant({ salesTaxKind: "inc", salesTaxPct: 8 }));
    m.orderFindUnique.mockResolvedValue({
      ...order(),
      items,
      subtotalCents: 6_600_000,
      taxCents: 0,
      discountCents: 1_320_000,
      discountPct: 20,
      tipCents: 528_000,
      totalCents: 5_808_000,
    });
    const s = await issuedSnapshot();
    // Neto cobrado: 52.800 = base 48.888,89 + INC 3.911,11 (antes: 61.111,11 + 4.888,89).
    expect(s).toMatchObject({
      discountCents: 1_320_000,
      discountPct: 20,
      embeddedTaxCents: 391_111,
      embeddedBaseCents: 4_888_889,
      discountInLines: { allowanceCents: 1_222_222 },
      totalCents: 5_808_000,
    });
    expect(s.embeddedTaxCents! + s.embeddedBaseCents!).toBe(6_600_000 - 1_320_000);
  });

  it("sin descuento no deja la marca: el snapshot de siempre", async () => {
    m.restaurantUpdate.mockResolvedValue(restaurant({ salesTaxKind: "inc", salesTaxPct: 8 }));
    m.orderFindUnique.mockResolvedValue({ ...order(), items, subtotalCents: 6_600_000, taxCents: 0, totalCents: 6_600_000 });
    const s = await issuedSnapshot();
    expect(s.discountInLines).toBeUndefined();
    expect(s.embeddedTaxCents! + s.embeddedBaseCents!).toBe(6_600_000);
  });
});


describe("sendSimpleInvoiceEmail — el TOTAL A PAGAR del correo", () => {
  const base = {
    restaurantName: "Restaurante de muestra", logoUrl: null, legalName: null, taxId: null, legalAddress: null,
    legalPhone: null, dianResolution: null, dianResolutionFrom: null, dianResolutionTo: null,
    dianResolutionDate: null, invoicePrefix: "FESM", shortCode: "A4F2", tableLabel: "Mesa 7",
    paidAtIso: "2026-11-04T23:10:00.000Z", items: [], subtotalCents: 12_000_000,
  };
  const send = (snapshot: InvoiceSnapshot) =>
    sendSimpleInvoiceEmail({
      invoiceId: "inv-1", snapshot, invoiceNumber: 77,
      invoiceUrl: "https://mesapay.co/factura/inv-1", email: "c@example.test", locale: "es",
    });
  const text = () => (m.sendEmail.mock.calls.at(-1) as unknown as [{ text: string }])[0].text;

  beforeEach(() => {
    m.sendEmail.mockClear();
    m.invoiceFindUnique.mockReset();
  });

  it("emitida al cobrar: la propina del snapshot, sin leer la orden", async () => {
    await send({ ...base, tipCents: 1_200_000, totalCents: 13_200_000 });
    expect(m.invoiceFindUnique).not.toHaveBeenCalled();
    expect(text()).toContain("Propina voluntaria: $12,000");
    expect(text()).toContain("TOTAL A PAGAR: $132,000");
  });

  it("emitida ANTES de cobrar: la propina REAL de la orden ya cobrada", async () => {
    m.invoiceFindUnique.mockResolvedValue({ order: { tipCents: 1_200_000, status: "paid" } });
    await send({ ...base, tipCents: 0, totalCents: 12_000_000, issuedBeforePayment: true });
    expect(m.invoiceFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "inv-1" } }),
    );
    expect(text()).toContain("Total comprobante: $120,000");
    expect(text()).toContain("TOTAL A PAGAR: $132,000");
  });
});
