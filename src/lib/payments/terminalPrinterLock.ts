import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getCloudPrintJobStatus } from "./kushki/cloudPrint";
import type { KushkiTerminalSetup } from "./terminalAvailability";

type Device = { serialNumber: string | null; kushkiDeviceId: string };

function serialKey(device: Device) {
  return device.serialNumber || `mock:${device.kushkiDeviceId}`;
}

// Take the same short transaction lock before inserting either reservation.
// No network I/O while holding a database connection or the order lock.
export async function printingUnderLock(tx: Prisma.TransactionClient, device: Device) {
  const serial = serialKey(device);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${serial}), 732)`;
  return tx.terminalPrintReservation.findUnique({ where: { serial } });
}

export async function releasePrint(device: Device, jobId: string, createdAt: Date) {
  await db.terminalPrintReservation.deleteMany({ where: { serial: serialKey(device), jobId, createdAt } });
}

// A queued or ambiguous dispatch outlives the HTTP request. On the next
// attempt, ask the provider about that job before deciding to free the device.
export async function refreshPreviousPrint(device: Device, setup: KushkiTerminalSetup) {
  const previous = await db.terminalPrintReservation.findUnique({ where: { serial: serialKey(device) } });
  if (!previous) return;
  // Allow the original 20s dispatch + 30s poll to finish before recovery.
  if (Date.now() - previous.createdAt.getTime() < 65_000) return;
  if (setup.useRealTerminal) {
    if (!device.serialNumber) return;
    const state = await getCloudPrintJobStatus({
      serialNumber: device.serialNumber, mode: setup.mode, businessCode: setup.businessCode, printJobId: previous.jobId,
    });
    if (state.status !== "COMPLETED" && state.status !== "FAILED" && state.httpStatus !== 404) return;
  }
  await releasePrint(device, previous.jobId, previous.createdAt);
}

export async function reservePrint(device: Device, jobId: string, createdAt = new Date()) {
  return db.$transaction(async tx => {
    const previous = await printingUnderLock(tx, device);
    if (previous) {
      return previous.jobId === jobId ? "already_queued" as const : "terminal_printing" as const;
    }
    const aliases = device.serialNumber
      ? await tx.terminalDevice.findMany({ where: { serialNumber: device.serialNumber }, select: { kushkiDeviceId: true } })
      : [device];
    const charge = await tx.financialOperation.findFirst({
      where: { kind: "terminal", status: { in: ["pending", "uncertain"] }, deviceId: { in: aliases.map(d => d.kushkiDeviceId) } },
      select: { key: true },
    });
    if (charge) return "terminal_charging" as const;
    await tx.terminalPrintReservation.create({ data: { serial: serialKey(device), jobId, createdAt } });
    return null;
  });
}
