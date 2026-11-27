import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(), recordFault: vi.fn(), lock: vi.fn(), previous: vi.fn(), create: vi.fn(), release: vi.fn(), probe: vi.fn(),
  charge: vi.fn(), transaction: vi.fn(), jobState: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {
  auditEvent: { create: mocks.audit }, $transaction: mocks.transaction, $executeRaw: mocks.recordFault,
  terminalPrintReservation: { findUnique: mocks.previous, deleteMany: mocks.release, updateMany: mocks.probe },
} }));
vi.mock("./kushki/cloudPrint", () => ({ getCloudPrintJobStatus: mocks.jobState }));

import { printingUnderLock, recordPrintFault, refreshPreviousPrint, reservePrint } from "./terminalPrinterLock";

const a = { serialNumber: "physical-A", kushkiDeviceId: "A" };
const b = { serialNumber: "physical-B", kushkiDeviceId: "B" };
const tx = {
  $executeRaw: mocks.lock,
  $queryRaw: mocks.charge,
  terminalPrintReservation: { findUnique: mocks.previous, create: mocks.create, deleteMany: mocks.release },
} as unknown as Prisma.TransactionClient;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(callback => callback(tx));
  mocks.charge.mockResolvedValue([]);
  mocks.probe.mockResolvedValue({ count: 1 });
});

describe("exclusión por serial físico", () => {
  it.each([["pending", "terminal_charging"], ["approved", "terminal_post_approval"]])(
    "la consulta bloquea %s solo en el serial afectado", async (status, conflict) => {
      mocks.charge.mockImplementation((_query, id) => id === a.kushkiDeviceId ? [{ status }] : []);
      expect(await reservePrint(a, "job-A")).toBe(conflict);
      expect(mocks.create).not.toHaveBeenCalled();
      expect(await reservePrint(b, "job-B")).toBeNull();
    });

  it("la misma impresión en curso no se vuelve a enviar", async () => {
    const row = { serial: a.serialNumber, jobId: "job-A", createdAt: new Date() };
    mocks.previous.mockImplementation(({ where }) => where.serial === a.serialNumber ? row : null);
    expect(await printingUnderLock(tx, a)).toEqual(row);
    expect(await printingUnderLock(tx, b)).toBeNull();
    expect(await reservePrint(a, "job-A")).toBe("already_queued");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  const setup = { mode: "sandbox" as const, useRealTerminal: true, businessCode: "mock" };
  it.each(["COMPLETED", "FAILED"])("sólo una confirmación tardía COMPLETED cuenta como respuesta (%s)", async status => {
    mocks.previous.mockResolvedValue({ serial: a.serialNumber, jobId: "job", createdAt: new Date(Date.now() - 75_000) });
    mocks.jobState.mockResolvedValue({ ok: true, status });
    await refreshPreviousPrint(a, setup, "restaurant");
    expect(mocks.audit).toHaveBeenCalledTimes(status === "COMPLETED" ? 1 : 0);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
  it.each([{ status: "PENDING" }, { ok: false, httpStatus: 503 }, { ok: false, error: "timeout" }])(
    "una respuesta %o no prolonga la reserva original más de tres minutos", async state => {
      const row = { serial: a.serialNumber, jobId: "job-A", createdAt: new Date(Date.now() - 75_000) };
      mocks.previous.mockResolvedValue(row);
      mocks.jobState.mockResolvedValue(state);
      await refreshPreviousPrint(a, setup, "restaurant");
      expect(await printingUnderLock(tx, a)).toBe(row);
      expect(mocks.release).not.toHaveBeenCalled();

      row.createdAt = new Date(Date.now() - 180_000);
      await refreshPreviousPrint(a, setup, "restaurant");
      expect(mocks.jobState).toHaveBeenCalledOnce();
      expect(await printingUnderLock(tx, a)).toBeNull();
      expect(mocks.release).toHaveBeenCalledWith({ where: row });
    });

  it.each(["PENDING", "IN_PROGRESS"])("registra el último estado %s al expirar y libera el serial", async lastJobStatus => {
    const createdAt = new Date(Date.now() - 181_000);
    mocks.previous.mockResolvedValue({ serial: a.serialNumber, jobId: "job", lastJobStatus, createdAt });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await printingUnderLock(tx, a)).toBeNull();
      expect(warn).toHaveBeenCalledWith("[terminal] print_expired_unfinished", expect.objectContaining({
        serial: a.serialNumber, lastJobStatus, durationMs: expect.any(Number),
      }));
      expect(mocks.release).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("un fallo al registrar el diagnóstico no interrumpe el flujo de impresión", async () => {
    const error = new Error("write failed");
    mocks.recordFault.mockRejectedValue(error);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(recordPrintFault(a, "job", new Date(), "timeout")).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledExactlyOnceWith("[terminal] print_fault_not_recorded", { serial: a.serialNumber, error });
    } finally {
      warn.mockRestore();
    }
  });

  it("una falla recién registrada después del sondeo conserva los 30 s de aviso suave", async () => {
    const row = { serial: a.serialNumber, jobId: "job", fault: "unconfirmed", createdAt: new Date(Date.now() - 75_000), faultAt: new Date() };
    mocks.previous.mockResolvedValue(row);
    expect(await reservePrint(a, "otro")).toBe("terminal_print_backoff");
    row.faultAt = new Date(Date.now() - 30_000);
    expect(await reservePrint(a, "otro")).toBe("terminal_stuck");
  });

  it("un busy confirmado frena nuevos envíos de impresión sin sondear trabajos inexistentes", async () => {
    mocks.previous.mockResolvedValue({ serial: a.serialNumber, jobId: "job", fault: "busy", faultAt: new Date(Date.now() - 30_000), createdAt: new Date(Date.now() - 70_000) });
    await refreshPreviousPrint(a, setup, "restaurant");
    expect(mocks.jobState).not.toHaveBeenCalled();
    expect(await reservePrint(a, "otro")).toBe("terminal_stuck");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
