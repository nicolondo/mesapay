import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

/**
 * Una ronda prepaga (counter / pickup con Kushki) nace "open" y NO se marcha
 * al crearse: se marcha acá, cuando el pago la activa. Sin rondas que
 * activar o sin auto-fire, la función escribe lo mismo que antes.
 */
const h = vi.hoisted(() => {
  const tx = {
    round: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => [{ id: "r1" }, { id: "r2" }]),
    },
    order: {
      findUnique: vi.fn(async () => ({
        restaurant: { kitchenAutoFire: false, barAutoFire: false },
      })),
    },
  };
  return { tx, fire: vi.fn(async () => [] as unknown[]) };
});

vi.mock("@/lib/kds/autoFire", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/kds/autoFire")>();
  return { ...mod, autoFireRoundInTx: h.fire };
});

import { activateOpenRounds } from "./prepaidRounds";

const tx = h.tx as unknown as Prisma.TransactionClient;

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.round.updateMany.mockResolvedValue({ count: 0 });
  h.tx.order.findUnique.mockResolvedValue({
    restaurant: { kitchenAutoFire: false, barAutoFire: false },
  });
  h.fire.mockResolvedValue([]);
});

describe("activateOpenRounds", () => {
  it("una cuenta de mesa (sin rondas abiertas) no lee nada más", async () => {
    expect(await activateOpenRounds(tx, "order")).toEqual([]);
    expect(h.tx.round.updateMany).toHaveBeenCalledWith({
      where: { orderId: "order", status: "open" },
      data: { status: "placed", placedAt: expect.any(Date) },
    });
    expect(h.tx.order.findUnique).not.toHaveBeenCalled();
    expect(h.fire).not.toHaveBeenCalled();
  });

  it("activa las rondas sin marchar nada cuando ninguna estación tiene auto-fire", async () => {
    h.tx.round.updateMany.mockResolvedValue({ count: 1 });
    expect(await activateOpenRounds(tx, "order")).toEqual([]);
    expect(h.tx.round.findMany).not.toHaveBeenCalled();
    expect(h.fire).not.toHaveBeenCalled();
  });

  it("con auto-fire marcha las rondas recién activadas y devuelve qué imprimir", async () => {
    h.tx.round.updateMany.mockResolvedValue({ count: 1 });
    h.tx.order.findUnique.mockResolvedValue({
      restaurant: { kitchenAutoFire: false, barAutoFire: true },
    });
    h.fire
      .mockResolvedValueOnce([{ station: "bar", barSubStation: null }])
      .mockResolvedValueOnce([]);

    expect(await activateOpenRounds(tx, "order")).toEqual([
      { roundId: "r1", groups: [{ station: "bar", barSubStation: null }] },
    ]);
    expect(h.fire).toHaveBeenCalledTimes(2);
    expect(h.fire).toHaveBeenCalledWith(tx, {
      roundId: "r1",
      flags: { kitchenAutoFire: false, barAutoFire: true },
      now: expect.any(Date),
    });
  });
});
