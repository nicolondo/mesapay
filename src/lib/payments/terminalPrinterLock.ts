import type { Prisma, TerminalPrintReservation } from "@prisma/client";
import { isTerminalBusy } from "./terminalBusy";
import { db } from "@/lib/db";
import { getCloudPrintJobStatus, type CloudPrintJobStatus } from "./kushki/cloudPrint";
import type { KushkiTerminalSetup } from "./terminalAvailability";
import { TERMINAL_IN_FLIGHT_MAX_MS } from "./terminalAttempt";

type Device = { serialNumber: string | null; kushkiDeviceId: string };

// Local policy. The provider has no "voucher screen closed" event or printer reset.
const POST_APPROVAL_MS = 60_000;
const PRINT_LIMIT_MS = 180_000;
const FIRST_PROBE_MS = 65_000; // Allow 20s dispatch + 30s poll + one final lookup.
const PROBE_INTERVAL_MS = 20_000;
const STUCK_AFTER_MS = 30_000;

function serialKey(device: Device) {
  return device.serialNumber || `mock:${device.kushkiDeviceId}`;
}

export function printConflict(previous: TerminalPrintReservation) {
  if (!previous.fault) return "terminal_printing";
  // Reservas anteriores a la migración no tienen hora de falla. Expiran igualmente.
  if (!previous.faultAt) return "terminal_print_backoff";
  const durationMs = Date.now() - previous.faultAt.getTime();
  if (durationMs < STUCK_AFTER_MS) return "terminal_print_backoff";
  console.warn("[terminal] print_stuck", { serial: previous.serial, fault: previous.fault, durationMs });
  return "terminal_stuck";
}

// Both writers take the same transaction lock. Expiry is independent of the
// provider and does not change any payment. No network I/O under this lock.
export async function printingUnderLock(tx: Prisma.TransactionClient, device: Device) {
  const serial = serialKey(device);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${serial}), 732)`;
  const row = await tx.terminalPrintReservation.findUnique({ where: { serial } });
  if (!row || Date.now() - row.createdAt.getTime() < PRINT_LIMIT_MS) return row;
  const unfinished = row.lastJobStatus === "PENDING" || row.lastJobStatus === "IN_PROGRESS";
  console.warn(unfinished ? "[terminal] print_expired_unfinished" : "[terminal] print_reservation_expired", {
    serial, durationMs: Date.now() - row.createdAt.getTime(), fault: row.fault, lastJobStatus: row.lastJobStatus,
  });
  await tx.terminalPrintReservation.deleteMany({ where: { serial, jobId: row.jobId, createdAt: row.createdAt } });
  return null;
}

export async function releasePrint(device: Device, jobId: string, createdAt: Date) {
  await db.terminalPrintReservation.deleteMany({ where: { serial: serialKey(device), jobId, createdAt } });
}

export async function recordPrintFault(
  device: Device, jobId: string, createdAt: Date, fault: "busy" | "timeout" | "unconfirmed", lastStatus?: CloudPrintJobStatus,
) {
  const serial = serialKey(device);
  // La primera falla inicia el aviso. Un sondeo posterior puede precisar el estado.
  try {
    const updated = await db.$executeRaw`
      UPDATE "TerminalPrintReservation"
      SET fault = ${fault}, "faultAt" = COALESCE("faultAt", ${new Date()}),
          "lastJobStatus" = COALESCE(${lastStatus ?? null}::text, "lastJobStatus")
      WHERE serial = ${serial} AND "jobId" = ${jobId} AND "createdAt" = ${createdAt}`;
    if (updated) console.warn("[terminal] print_unavailable", { serial, jobId, fault, durationMs: Date.now() - createdAt.getTime() });
  } catch (error) {
    console.warn("[terminal] print_fault_not_recorded", { serial, error });
  }
}

export async function refreshPreviousPrint(device: Device, setup: KushkiTerminalSetup) {
  const serial = serialKey(device);
  const previous = await db.terminalPrintReservation.findUnique({ where: { serial } });
  if (!previous) return;
  const age = Date.now() - previous.createdAt.getTime();
  // A definite busy refusal has no remote job. Back off printing on this
  // serial until expiry, but allow charges to claim it immediately.
  if (age < FIRST_PROBE_MS || age >= PRINT_LIMIT_MS || previous.fault === "busy") return;
  if (setup.useRealTerminal) {
    if (!device.serialNumber) return;
    const probe = await db.terminalPrintReservation.updateMany({
      where: { serial, createdAt: previous.createdAt, jobId: previous.jobId, OR: [{ nextProbeAt: null }, { nextProbeAt: { lte: new Date() } }] },
      data: { nextProbeAt: new Date(Date.now() + PROBE_INTERVAL_MS) },
    });
    if (!probe.count) return;
    const state = await getCloudPrintJobStatus({
      serialNumber: device.serialNumber, mode: setup.mode, businessCode: setup.businessCode, printJobId: previous.jobId,
    });
    if (state.status === "FAILED" && isTerminalBusy(state.errorCode, state.errorMessage)) {
      await recordPrintFault(device, previous.jobId, previous.createdAt, "busy", "FAILED");
      return;
    }
    if (state.ok && (state.status === "PENDING" || state.status === "IN_PROGRESS") && state.status !== previous.lastJobStatus) {
      await db.terminalPrintReservation.updateMany({
        where: { serial, jobId: previous.jobId, createdAt: previous.createdAt, lastJobStatus: previous.lastJobStatus },
        data: { lastJobStatus: state.status },
      }).catch(() => console.warn("[terminal] print_status_not_recorded", { serial, jobId: previous.jobId }));
    }
    if (state.status !== "COMPLETED" && state.status !== "FAILED" && state.httpStatus !== 404) return;
  }
  await releasePrint(device, previous.jobId, previous.createdAt);
}

export async function reservePrint(device: Device, jobId: string, createdAt = new Date()) {
  return db.$transaction(async tx => {
    const previous = await printingUnderLock(tx, device);
    if (previous) {
      if (!previous.fault && previous.jobId === jobId) return "already_queued" as const;
      return printConflict(previous);
    }
    // Join the payment and its claim in one snapshot: an approval transfers
    // protection directly from the live charge to the voucher grace period.
    const activeSince = new Date(createdAt.getTime() - TERMINAL_IN_FLIGHT_MAX_MS);
    const approvedSince = new Date(createdAt.getTime() - POST_APPROVAL_MS);
    const [payment] = await tx.$queryRaw<{ status: string }[]>`
      SELECT p.status FROM "FinancialOperation" f
      JOIN "Payment" p ON p.id = f."paymentId"
      JOIN "TerminalDevice" d ON d."kushkiDeviceId" = f."deviceId"
      WHERE f.kind = 'terminal' AND (d."kushkiDeviceId" = ${device.kushkiDeviceId} OR d."serialNumber" = ${device.serialNumber})
        AND ((f.status = 'pending' AND f."answeredAt" IS NULL AND f."createdAt" > ${activeSince}
              AND p.status = 'pending' AND NOT p."reconciliationRequired")
          OR (f.status = 'completed' AND p.status = 'approved' AND p."settledAt" > ${approvedSince}))
      ORDER BY p."settledAt" DESC NULLS FIRST LIMIT 1`;
    if (payment) return payment.status === "approved" ? "terminal_post_approval" as const : "terminal_charging" as const;
    await tx.terminalPrintReservation.create({ data: { serial: serialKey(device), jobId, createdAt } });
    return null;
  });
}
