import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Línea libre con el impuesto del comercio INCLUIDO en el precio.
 *
 * El dueño reportó que "las facturas manuales no toman el impuesto": una
 * factura manual se arma con cargos (líneas libres) y el selector de
 * impuesto nacía en "Ninguno", así que el cargo salía sin impoconsumo
 * mientras que el mismo valor en platos de una mesa sí lo declaraba
 * (embebido). Con `taxKind: "included"` la línea queda como un plato de la
 * carta (`taxKind` null en la fila): el precio digitado es lo que se cobra y
 * el impuesto del comercio va adentro — tirilla, XML y contabilidad lo
 * tratan exactamente igual que a un plato.
 */
const m = vi.hoisted(() => {
  const tx = {
    orderItem: { create: vi.fn() },
  };
  return {
    auth: vi.fn(),
    active: vi.fn(),
    orderFindUnique: vi.fn(),
    restaurantFindUnique: vi.fn(),
    requireMutable: vi.fn(),
    recompute: vi.fn(),
    audit: vi.fn(async () => {}),
    event: vi.fn(),
    tx,
    transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.active }));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({
  db: {
    $transaction: m.transaction,
    order: { findUnique: m.orderFindUnique },
    restaurant: { findUnique: m.restaurantFindUnique },
  },
}));
vi.mock("@/lib/orders", () => ({
  requireMutableOrderInTx: m.requireMutable,
  recomputeOrderLinesInTx: m.recompute,
}));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: m.event }));

import { POST } from "./route";

const post = (body: unknown) =>
  POST(
    new Request("http://localhost/api/operator/order-items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const line = { orderId: "order-1", name: "Almuerzos evento", qty: 10, unitPriceCents: 2_500_000 };

beforeEach(() => {
  vi.resetAllMocks();
  m.auth.mockResolvedValue({ user: { id: "user-1", role: "operator" } });
  m.active.mockResolvedValue("rest-1");
  m.orderFindUnique.mockResolvedValue({
    id: "order-1",
    restaurantId: "rest-1",
    status: "served",
    subtotalCents: 0,
    taxCents: 0,
    tipCents: 0,
    table: { number: -100 },
  });
  m.restaurantFindUnique.mockResolvedValue({ country: "CO" });
  m.requireMutable.mockResolvedValue({ subtotalCents: 0, taxCents: 0, tipCents: 0 });
  m.transaction.mockImplementation(async (fn) => fn(m.tx));
  m.tx.orderItem.create.mockResolvedValue({ id: "item-1" });
  m.recompute.mockResolvedValue({ subtotalCents: 25_000_000, taxCents: 0, totalCents: 25_000_000 });
});

describe("POST /api/operator/order-items — impuesto incluido en el precio", () => {
  it("con taxKind 'included' la línea nace como un plato de la carta: sin impuesto propio, nada encima", async () => {
    const res = await post({ ...line, taxKind: "included", taxPct: 0 });
    expect(res.status).toBe(200);
    expect(m.tx.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          menuItemId: null,
          roundId: null,
          nameSnapshot: "Almuerzos evento",
          priceCentsSnapshot: 2_500_000,
          qty: 10,
          // null = impuesto del comercio embebido, igual que un plato del menú.
          taxKind: null,
          taxPct: null,
        }),
      }),
    );
    // Nada se suma encima: lo digitado es lo que se cobra.
    expect(await res.json()).toMatchObject({ ok: true, lineCents: 25_000_000, lineTaxCents: 0 });
    // No se valida una tarifa que no existe (la del comercio se congela al facturar).
    expect(m.restaurantFindUnique).not.toHaveBeenCalled();
  });

  it("'included' ignora una tarifa suelta: la del comercio manda", async () => {
    const res = await post({ ...line, taxKind: "included", taxPct: 19 });
    expect(res.status).toBe(200);
    expect(m.tx.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ taxKind: null, taxPct: null }) }),
    );
  });

  it("una línea con impuesto propio sigue sumándolo encima", async () => {
    const res = await post({ ...line, taxKind: "iva", taxPct: 19 });
    expect(res.status).toBe(200);
    expect(m.tx.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ taxKind: "iva", taxPct: 19 }) }),
    );
    expect(await res.json()).toMatchObject({ lineCents: 25_000_000, lineTaxCents: 4_750_000 });
  });

  it("una tarifa que no existe en el país se sigue rechazando", async () => {
    const res = await post({ ...line, taxKind: "inc", taxPct: 19 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_tax_rate" });
    expect(m.tx.orderItem.create).not.toHaveBeenCalled();
  });
});
