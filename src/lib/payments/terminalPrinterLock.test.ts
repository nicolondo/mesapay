import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  lock: vi.fn(), previous: vi.fn(), create: vi.fn(), release: vi.fn(), devices: vi.fn(),
  charge: vi.fn(), transaction: vi.fn(), jobState: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {
  $transaction: mocks.transaction,
  terminalPrintReservation: { findUnique: mocks.previous, deleteMany: mocks.release },
} }));
vi.mock("./kushki/cloudPrint", () => ({ getCloudPrintJobStatus: mocks.jobState }));

import { printingUnderLock, refreshPreviousPrint, reservePrint } from "./terminalPrinterLock";

const a = { serialNumber: "physical-A", kushkiDeviceId: "A" };
const b = { serialNumber: "physical-B", kushkiDeviceId: "B" };
const tx = {
  $executeRaw: mocks.lock,
  financialOperation: { findFirst: mocks.charge },
  terminalPrintReservation: { findUnique: mocks.previous, create: mocks.create },
  terminalDevice: { findMany: mocks.devices },
} as unknown as Prisma.TransactionClient;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(callback => callback(tx));
  mocks.devices.mockImplementation(({ where }) => where.serialNumber === a.serialNumber ? [a, { kushkiDeviceId: "alias" }] : [b]);
});

describe("exclusión por serial físico", () => {
  it("un cobro por otro alias del mismo serial impide imprimir, pero permite otro serial", async () => {
    mocks.charge.mockImplementation(({ where }) => where.deviceId.in.includes("alias") ? { key: "terminal:payment" } : null);
    expect(await reservePrint(a, "job-A")).toBe("terminal_charging");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(await reservePrint(b, "job-B")).toBeNull();
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it("una impresión bloquea el push de cobro solo al mismo serial", async () => {
    mocks.previous.mockImplementation(({ where }) => where.serial === a.serialNumber ? { jobId: "job-A" } : null);
    expect(await printingUnderLock(tx, a)).toEqual({ jobId: "job-A" });
    expect(await printingUnderLock(tx, b)).toBeNull();
    expect(await reservePrint(a, "job-A")).toBe("already_queued");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("el tiempo por sí solo no libera una impresión pendiente o sin respuesta", async () => {
    mocks.previous.mockResolvedValue({ jobId: "job-A", createdAt: new Date(0) });
    const setup = { mode: "sandbox" as const, useRealTerminal: true, businessCode: "mock" };
    for (const result of [{ status: "IN_PROGRESS" }, { ok: false, httpStatus: 503 }]) {
      mocks.jobState.mockResolvedValueOnce(result);
      await refreshPreviousPrint(a, setup);
      expect(mocks.release).not.toHaveBeenCalled();
    }
    mocks.jobState.mockResolvedValueOnce({ status: "COMPLETED" });
    await refreshPreviousPrint(a, setup);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
