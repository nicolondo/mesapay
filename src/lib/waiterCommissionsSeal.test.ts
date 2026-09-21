import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOrderWaiter, sealOrderCommission, type CommissionSealClient } from "./waiterCommissionsSeal";

/**
 * El sellado habla con Prisma, así que el cliente va mockeado (sirve igual
 * `db` o una `tx`: sólo usa `order` y `user`). Lo que se prueba es la
 * DECISIÓN — a quién se le sella, con qué % y cuándo NO — y las dos
 * garantías del cobro: idempotente y sin excepciones.
 */
const m = vi.hoisted(() => ({
  orderFindUnique: vi.fn(),
  orderUpdateMany: vi.fn(),
  userFindMany: vi.fn(),
}));

const client = {
  order: { findUnique: m.orderFindUnique, updateMany: m.orderUpdateMany },
  user: { findMany: m.userFindMany },
} as unknown as CommissionSealClient;

type OrderRow = {
  id: string;
  restaurantId: string;
  status: string;
  subtotalCents: number;
  discountCents: number;
  commissionSealedAt: Date | null;
  table: { number: number } | null;
  payments: { collectedByUserId: string | null; amountCents: number }[];
};

function order(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "o1",
    restaurantId: "r1",
    status: "paid",
    subtotalCents: 100_000,
    discountCents: 0,
    commissionSealedAt: null,
    table: { number: 5 },
    payments: [{ collectedByUserId: "w-ana", amountCents: 100_000 }],
    ...over,
  };
}

const ANA = { id: "w-ana", waiterCommissionBps: 250 };
const LUIS = { id: "w-luis", waiterCommissionBps: 500 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  m.orderUpdateMany.mockResolvedValue({ count: 1 });
});

describe("sealOrderCommission", () => {
  it("sella con el % del mesero que cobró: quién, bps, base y comisión, en una sola escritura", async () => {
    m.orderFindUnique.mockResolvedValue(order());
    m.userFindMany.mockResolvedValue([ANA]);

    const res = await sealOrderCommission(client, "o1");

    expect(res).toEqual({
      sealed: true,
      waiterId: "w-ana",
      bps: 250,
      baseCents: 100_000,
      commissionCents: 2_500,
    });
    // Busca al que cobró entre los MESEROS del comercio (no un operador).
    expect(m.userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["w-ana"] }, restaurantId: "r1", role: "mesero" },
      }),
    );
    expect(m.orderUpdateMany).toHaveBeenCalledTimes(1);
    const call = m.orderUpdateMany.mock.calls[0][0];
    // Guardia de idempotencia en el propio UPDATE.
    expect(call.where).toEqual({ id: "o1", commissionSealedAt: null });
    expect(call.data).toMatchObject({
      commissionWaiterId: "w-ana",
      commissionBps: 250,
      commissionBaseCents: 100_000,
      commissionCents: 2_500,
    });
    expect(call.data.commissionSealedAt).toBeInstanceOf(Date);
  });

  it("la base descuenta el descuento del comensal", async () => {
    m.orderFindUnique.mockResolvedValue(order({ subtotalCents: 50_000, discountCents: 5_000 }));
    m.userFindMany.mockResolvedValue([ANA]);
    const res = await sealOrderCommission(client, "o1");
    expect(res).toMatchObject({ sealed: true, baseCents: 45_000, commissionCents: 1_125 });
  });

  it("no sella si el mesero no tiene % configurado", async () => {
    m.orderFindUnique.mockResolvedValue(order());
    m.userFindMany.mockResolvedValue([{ id: "w-ana", waiterCommissionBps: null }]);
    expect(await sealOrderCommission(client, "o1")).toEqual({ sealed: false, reason: "no_rate" });
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("no sella sin mesero: cobró el operador y la mesa no tiene mesero asignado", async () => {
    m.orderFindUnique.mockResolvedValue(order({ payments: [{ collectedByUserId: "op-1", amountCents: 100_000 }] }));
    // 1.ª consulta: op-1 no es mesero → []. 2.ª: nadie tiene la mesa 5 → [].
    m.userFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await sealOrderCommission(client, "o1")).toEqual({ sealed: false, reason: "no_waiter" });
    expect(m.userFindMany).toHaveBeenCalledTimes(2);
    expect(m.userFindMany.mock.calls[1][0].where).toEqual({
      restaurantId: "r1",
      role: "mesero",
      disabledAt: null,
      assignedTableNumbers: { has: 5 },
    });
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("si nadie del staff cobró (pago desde el QR), cae al mesero de la mesa asignada", async () => {
    m.orderFindUnique.mockResolvedValue(order({ payments: [] }));
    m.userFindMany.mockResolvedValueOnce([LUIS]);
    const res = await sealOrderCommission(client, "o1");
    expect(res).toMatchObject({ sealed: true, waiterId: "w-luis", bps: 500, commissionCents: 5_000 });
    // Sin pagos del staff no se consulta a nadie por «quién cobró».
    expect(m.userFindMany).toHaveBeenCalledTimes(1);
  });

  it("dos meseros en la misma mesa es ambiguo: no comisiona", async () => {
    m.orderFindUnique.mockResolvedValue(order({ payments: [] }));
    m.userFindMany.mockResolvedValueOnce([ANA, LUIS]);
    expect(await sealOrderCommission(client, "o1")).toEqual({ sealed: false, reason: "no_waiter" });
  });

  it("cuentas de recogida / factura manual (mesa negativa) no tienen mesero de sección", async () => {
    m.orderFindUnique.mockResolvedValue(order({ payments: [], table: { number: -1 } }));
    expect(await sealOrderCommission(client, "o1")).toEqual({ sealed: false, reason: "no_waiter" });
    expect(m.userFindMany).not.toHaveBeenCalled();
  });

  it("no re-sella una cuenta que ya tiene commissionSealedAt", async () => {
    m.orderFindUnique.mockResolvedValue(order({ commissionSealedAt: new Date("2026-09-01T00:00:00Z") }));
    expect(await sealOrderCommission(client, "o1")).toEqual({ sealed: false, reason: "already_sealed" });
    expect(m.userFindMany).not.toHaveBeenCalled();
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("si otro riel selló entre la lectura y la escritura, el guardia del UPDATE lo detecta", async () => {
    m.orderFindUnique.mockResolvedValue(order());
    m.userFindMany.mockResolvedValue([ANA]);
    m.orderUpdateMany.mockResolvedValue({ count: 0 });
    expect(await sealOrderCommission(client, "o1")).toEqual({ sealed: false, reason: "race" });
  });

  it("no sella cuentas que no están pagadas ni cuentas en $0 (cortesías)", async () => {
    m.orderFindUnique.mockResolvedValue(order({ status: "paying" }));
    expect(await sealOrderCommission(client, "o1")).toEqual({ sealed: false, reason: "not_paid" });

    m.orderFindUnique.mockResolvedValue(order({ subtotalCents: 0 }));
    m.userFindMany.mockResolvedValue([ANA]);
    expect(await sealOrderCommission(client, "o1")).toEqual({ sealed: false, reason: "zero_base" });
    expect(m.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("cuenta inexistente", async () => {
    m.orderFindUnique.mockResolvedValue(null);
    expect(await sealOrderCommission(client, "nope")).toEqual({ sealed: false, reason: "not_found" });
  });

  it("NUNCA lanza: si la DB falla, registra [comisiones] y devuelve error", async () => {
    m.orderFindUnique.mockRejectedValue(new Error("connection reset"));
    await expect(sealOrderCommission(client, "o1")).resolves.toEqual({ sealed: false, reason: "error" });
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[comisiones]"),
      expect.objectContaining({ orderId: "o1", err: "connection reset" }),
    );

    // También si falla la escritura.
    m.orderFindUnique.mockResolvedValue(order());
    m.userFindMany.mockResolvedValue([ANA]);
    m.orderUpdateMany.mockRejectedValue(new Error("P2022"));
    await expect(sealOrderCommission(client, "o1")).resolves.toEqual({ sealed: false, reason: "error" });
  });
});

describe("resolveOrderWaiter — cuenta dividida entre dos meseros", () => {
  it("gana el que cobró más plata, aunque haya cobrado después", async () => {
    m.userFindMany.mockResolvedValue([ANA, LUIS]);
    const w = await resolveOrderWaiter(client, {
      restaurantId: "r1",
      table: { number: 5 },
      payments: [
        { collectedByUserId: "w-ana", amountCents: 30_000 },
        { collectedByUserId: "w-luis", amountCents: 70_000 },
      ],
    });
    expect(w?.id).toBe("w-luis");
  });

  it("a igual plata, el primero que cobró", async () => {
    m.userFindMany.mockResolvedValue([ANA, LUIS]);
    const w = await resolveOrderWaiter(client, {
      restaurantId: "r1",
      table: { number: 5 },
      payments: [
        { collectedByUserId: "w-luis", amountCents: 50_000 },
        { collectedByUserId: "w-ana", amountCents: 50_000 },
      ],
    });
    expect(w?.id).toBe("w-luis");
  });

  it("un cobro del operador no bloquea la atribución al mesero que también cobró", async () => {
    // op-1 cobró más, pero no es mesero: entre los meseros gana Ana.
    m.userFindMany.mockResolvedValue([ANA]);
    const w = await resolveOrderWaiter(client, {
      restaurantId: "r1",
      table: { number: 5 },
      payments: [
        { collectedByUserId: "op-1", amountCents: 80_000 },
        { collectedByUserId: "w-ana", amountCents: 20_000 },
      ],
    });
    expect(w?.id).toBe("w-ana");
  });
});
