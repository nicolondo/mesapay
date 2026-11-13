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

/**
 * Tope DINÁMICO del valor (ver `src/lib/freeLineLimit.ts`). Antes era $10M
 * fijo por línea: un cargo de ~$12 millones con impoconsumo incluido en una
 * cuenta vacía se rechazaba (y el diálogo apagaba el botón sin decir nada).
 */
describe("POST /api/operator/order-items — tope dinámico del cargo", () => {
  // Lo cobrable más alto que deja el techo ($20M) con la propina máxima (30 %).
  const MAX_CHARGEABLE = Math.floor((2_000_000_000 * 100) / 130);

  it("acepta un cargo de $12.219.480 con impoconsumo incluido en una cuenta vacía", async () => {
    const res = await post({
      orderId: "order-1",
      name: "Evento empresarial",
      qty: 1,
      unitPriceCents: 1_221_948_000,
      taxKind: "included",
      taxPct: 0,
    });
    expect(res.status).toBe(200);
    expect(m.tx.orderItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priceCentsSnapshot: 1_221_948_000, qty: 1, taxKind: null }),
      }),
    );
    expect(await res.json()).toMatchObject({ ok: true, lineCents: 1_221_948_000, lineTaxCents: 0 });
  });

  it("rechaza lo que pasaría el techo con `line_too_large` y el máximo que sí cabe en ESA cuenta", async () => {
    // La cuenta ya tiene $10M: con otro cargo de $8M pasaría el techo.
    m.orderFindUnique.mockResolvedValue({
      id: "order-1",
      restaurantId: "rest-1",
      status: "served",
      subtotalCents: 1_000_000_000,
      taxCents: 0,
      tipCents: 0,
      table: { number: 4 },
    });
    const res = await post({ ...line, qty: 1, unitPriceCents: 800_000_000, taxKind: "included", taxPct: 0 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "line_too_large",
      maxLineCents: MAX_CHARGEABLE - 1_000_000_000,
    });
    expect(m.transaction).not.toHaveBeenCalled();
    expect(m.tx.orderItem.create).not.toHaveBeenCalled();
  });

  it("con IVA encima el máximo descuenta el impuesto que se suma", async () => {
    const res = await post({ ...line, qty: 1, unitPriceCents: 1_400_000_000, taxKind: "iva", taxPct: 19 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("line_too_large");
    // max + 19% ≤ espacio libre
    expect(body.maxLineCents + Math.round((body.maxLineCents * 19) / 100)).toBeLessThanOrEqual(MAX_CHARGEABLE);
    expect(body.maxLineCents).toBeLessThan(MAX_CHARGEABLE);
  });

  it("vuelve a medir con la cuenta bloqueada: si otro dispositivo la llenó, rechaza sin escribir", async () => {
    // Al leer estaba vacía; dentro de la transacción ya tiene $14M.
    m.requireMutable.mockResolvedValue({ subtotalCents: 1_400_000_000, taxCents: 0, tipCents: 0 });
    const res = await post({ ...line, qty: 1, unitPriceCents: 1_221_948_000, taxKind: "included", taxPct: 0 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "line_too_large",
      maxLineCents: MAX_CHARGEABLE - 1_400_000_000,
    });
    expect(m.tx.orderItem.create).not.toHaveBeenCalled();
    expect(m.recompute).not.toHaveBeenCalled();
  });

  it("la cantidad multiplica: 2 × $8M no cabe aunque cada uno sí", async () => {
    const res = await post({ ...line, qty: 2, unitPriceCents: 800_000_000, taxKind: "included", taxPct: 0 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("line_too_large");
  });
});
