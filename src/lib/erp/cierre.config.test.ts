// La config contable se crea perezosamente: dos peticiones simultáneas sobre
// un comercio sin fila (tax-context pide conceptos y config en PARALELO)
// chocaban con el índice único porque el upsert de Prisma no es atómico.
// Puso rojo el CI del PR #640 por azar; el choque se reintenta y lee la fila.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const m = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { accountingConfig: { upsert: m.upsert } } }));
import { getAccountingConfig } from "./cierre";

const row = { uvtCents: 5_237_400, closedThrough: null, nextVoucherNumber: 1 };
const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`restaurantId`)", {
    code: "P2002",
    clientVersion: "test",
  });

beforeEach(() => vi.resetAllMocks());

describe("getAccountingConfig", () => {
  it("devuelve la fila (creándola si no existe)", async () => {
    m.upsert.mockResolvedValue(row);
    await expect(getAccountingConfig("r1")).resolves.toEqual(row);
    expect(m.upsert).toHaveBeenCalledTimes(1);
  });

  it("si otra petición creó la fila en medio del upsert (P2002), reintenta y la lee", async () => {
    m.upsert.mockRejectedValueOnce(p2002()).mockResolvedValue(row);
    await expect(getAccountingConfig("r1")).resolves.toEqual(row);
    expect(m.upsert).toHaveBeenCalledTimes(2);
  });

  it("cualquier otro error de base de datos sube tal cual", async () => {
    const boom = new Error("db down");
    m.upsert.mockRejectedValue(boom);
    await expect(getAccountingConfig("r1")).rejects.toBe(boom);
    expect(m.upsert).toHaveBeenCalledTimes(1);
  });
});
