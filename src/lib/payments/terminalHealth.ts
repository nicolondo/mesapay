import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

type Device = { kushkiDeviceId: string; serialNumber: string | null; label: string; active: boolean };
export function terminalSerial(device: Pick<Device, "kushkiDeviceId" | "serialNumber">) {
  return device.serialNumber || `mock:${device.kushkiDeviceId}`;
}

export type TerminalHealthWarning = {
  deviceIds: string[];
  label: string;
  serial: string | null;
  since: string;
  count: number;
};
type Evidence = { serial: string; at: Date; kind: "timeout" | "approved" | "answered" | "printed" };

// Each timeout belongs to one pushed charge. Local cancellation, print queueing and
// elapsed time say nothing about whether the physical terminal can answer again.
export function terminalWarnings(devices: Device[], evidence: Evidence[]): TerminalHealthWarning[] {
  const lastResponse = new Map<string, number>();
  for (const event of evidence) {
    if (event.kind !== "timeout") {
      lastResponse.set(event.serial, Math.max(lastResponse.get(event.serial) ?? 0, event.at.getTime()));
    }
  }
  const failures = new Map<string, { count: number; since: number }>();
  for (const event of evidence) {
    const time = event.at.getTime();
    if (event.kind !== "timeout" || time <= (lastResponse.get(event.serial) ?? 0)) continue;
    const streak = failures.get(event.serial);
    failures.set(event.serial, { count: (streak?.count ?? 0) + 1, since: Math.min(streak?.since ?? time, time) });
  }
  const warnings = new Map<string, TerminalHealthWarning>();
  for (const device of devices) {
    const serial = terminalSerial(device);
    const streak = failures.get(serial);
    if (!device.active || !streak || streak.count < 2) continue;
    const warning = warnings.get(serial);
    if (warning) {
      warning.deviceIds.push(device.kushkiDeviceId);
    } else {
      warnings.set(serial, {
        deviceIds: [device.kushkiDeviceId], label: device.label, serial: device.serialNumber,
        since: new Date(streak.since).toISOString(), count: streak.count,
      });
    }
  }
  return [...warnings.values()];
}

const PRINT_COMPLETED = "terminal.print.completed";

// Print reservations disappear when the job finishes. Keep the positive receipt
// in the existing tenant audit trail, including a COMPLETED returned by a late probe.
export async function recordCompletedPrint(restaurantId: string, device: Pick<Device, "serialNumber" | "kushkiDeviceId">, jobId: string) {
  const serial = terminalSerial(device);
  try {
    await db.auditEvent.create({ data: {
      restaurantId, kind: PRINT_COMPLETED, targetType: "terminal", targetId: serial,
      actorRole: "system", actorEmail: "system", summary: serial, diff: { jobId },
    } });
  } catch (error) {
    console.warn("[terminal] print_completion_not_recorded", { serial, jobId, error });
  }
}

export async function readTerminalWarnings(restaurantId: string) {
  const devices = await db.terminalDevice.findMany({
    where: { restaurantId }, orderBy: { createdAt: "asc" },
    select: { kushkiDeviceId: true, serialNumber: true, active: true, label: true },
  });
  if (!devices.some(d => d.active)) return [];
  // A configuration row can be reassigned to a replacement terminal. Resolve
  // its serial at push time, including for a reply received after reassignment.
  const claims = Prisma.sql`
    SELECT f."paymentId", f."createdAt", f."gatewayTimedOutAt", f."answeredAt", COALESCE((
      SELECT a.diff->>'previousSerial' FROM "AuditEvent" a
      WHERE a."restaurantId" = ${restaurantId} AND a.kind = 'terminal.serial.changed'
        AND a."targetId" = f."deviceId" AND a."occurredAt" > f."createdAt"
      ORDER BY a."occurredAt" LIMIT 1
    ), NULLIF(d."serialNumber", ''), 'mock:' || d."kushkiDeviceId") AS serial
    FROM "Order" o JOIN "Payment" p ON p."orderId" = o.id
    JOIN "FinancialOperation" f ON f.key = 'terminal:' || p.id
    JOIN "TerminalDevice" d ON d."kushkiDeviceId" = f."deviceId" AND d."restaurantId" = o."restaurantId"
    WHERE o."restaurantId" = ${restaurantId} AND p.method = 'kushki_card_terminal' AND f.kind = 'terminal'`;
  const timeouts = await db.$queryRaw<Evidence[]>`
    WITH claims AS (${claims})
    SELECT serial, "gatewayTimedOutAt" AS at, 'timeout' AS kind
    FROM claims WHERE "gatewayTimedOutAt" IS NOT NULL`;
  const candidates = terminalWarnings(devices, timeouts);
  if (!candidates.length) return [];
  const serials = candidates.map(w => w.serial || `mock:${w.deviceIds[0]}`);
  const since = new Date(Math.min(...candidates.map(w => Date.parse(w.since))));
  // Some synchronous bank declines settle via webhook without setting answeredAt.
  // A search can confirm an OLD charge after two newer timeouts. Attribute
  // that evidence to its original attempt, never to the time of the lookup.
  const responses = await db.$queryRaw<Evidence[]>`
    WITH claims AS (${claims}), replies AS (
      SELECT serial, "answeredAt" AS at FROM claims WHERE "answeredAt" >= ${since}
      UNION ALL
      SELECT f.serial, CASE WHEN w.payload->>'message' = 'transaction_search_online'
        THEN COALESCE(f."gatewayTimedOutAt", f."createdAt") ELSE w."createdAt" END
      FROM "KushkiWebhookEvent" w
      JOIN claims f ON f."paymentId" = w.payload->>'paymentId'
      WHERE (w."restaurantId" IS NULL OR w."restaurantId" = ${restaurantId}) AND w."processedAt" IS NOT NULL
        AND w."createdAt" >= ${since} AND (w.type = 'terminal.approved' OR (w.type = 'terminal.declined'
          AND (w."eventId" LIKE 'cloudterm:' || f."paymentId" || ':no:%'
            OR w."eventId" LIKE 'cloudterm:' || f."paymentId" || ':search-declined:%' OR w."eventId" LIKE 'mock-%')))
      UNION ALL
      SELECT f.serial, CASE WHEN a.diff->>'source' = 'transaction_search_online'
        THEN COALESCE(f."gatewayTimedOutAt", f."createdAt") ELSE a."occurredAt" END
      FROM "AuditEvent" a JOIN claims f ON f."paymentId" = a."targetId"
      WHERE a."restaurantId" = ${restaurantId} AND a.kind = 'payment.terminal_amount_mismatch' AND a."occurredAt" >= ${since}
    )
    SELECT serial, MAX(at) AS at, 'answered' AS kind FROM replies WHERE serial IN (${Prisma.join(serials)}) GROUP BY serial
    UNION ALL
    SELECT "targetId" AS serial, MAX("occurredAt") AS at, 'printed' AS kind FROM "AuditEvent"
    WHERE "restaurantId" = ${restaurantId} AND kind = ${PRINT_COMPLETED} AND "occurredAt" >= ${since}
      AND "targetId" IN (${Prisma.join(serials)}) GROUP BY "targetId"`;
  return terminalWarnings(devices, [...timeouts, ...responses]);
}
