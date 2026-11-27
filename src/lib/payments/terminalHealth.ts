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
type Evidence = { paymentId?: string | null; serial: string; at: Date; kind: "timeout" | "cloud_busy" | "approved" | "answered" | "printed" };

// Each timeout belongs to one pushed charge. Local cancellation, print queueing and
// elapsed time say nothing about whether the physical terminal can answer again.
export function terminalWarnings(devices: Device[], evidence: Evidence[]): TerminalHealthWarning[] {
  const lastResponse = new Map<string, number>();
  for (const event of evidence) {
    if (event.kind !== "timeout" && event.kind !== "cloud_busy") {
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
  // Cloud refusals only corroborate an earlier unanswered timeout on this serial.
  for (const event of evidence) {
    if (event.kind !== "cloud_busy") continue;
    const streak = failures.get(event.serial);
    if (streak && event.at.getTime() > streak.since) streak.count++;
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

// Prisma stores DateTime as UTC timestamps without a time zone. CURRENT_TIMESTAMP
// is stable throughout the statement, including all the response/print lookups.
const HEALTH_WINDOW_START = Prisma.sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC') - INTERVAL '48 hours'`;
export const CLOUD_BUSY_ANSWER = "INTERNAL/TERMINAL_BUSY";
export const TERMINAL_PRINT_COMPLETED = "terminal.print.completed";

// Print reservations disappear when the job finishes. Keep the positive receipt
// in the existing tenant audit trail, including a COMPLETED returned by a late probe.
export async function recordCompletedPrint(restaurantId: string, device: Pick<Device, "serialNumber" | "kushkiDeviceId">, jobId: string) {
  const serial = terminalSerial(device);
  try {
    await db.auditEvent.create({ data: {
      restaurantId, kind: TERMINAL_PRINT_COMPLETED, targetType: "terminal", targetId: serial,
      actorRole: "system", actorEmail: "system", summary: serial, diff: { jobId },
    } });
  } catch (error) {
    console.warn("[terminal] print_completion_not_recorded", { serial, jobId, error });
  }
}

export async function readTerminalWarnings(restaurantId: string, busyPaymentId?: string) {
  const devices = await db.terminalDevice.findMany({
    where: { restaurantId }, orderBy: { createdAt: "asc" },
    select: { kushkiDeviceId: true, serialNumber: true, active: true, label: true },
  });
  if (!devices.some(d => d.active)) return [];
  // A configuration row can be reassigned to a replacement terminal. Resolve
  // its serial at push time, including for a reply received after reassignment.
  const evidence = await db.$queryRaw<Evidence[]>`
    WITH claims AS MATERIALIZED (
      SELECT f."paymentId", f."createdAt", f."gatewayTimedOutAt", f."answeredAt", f."answerCode", COALESCE((
        SELECT a.diff->>'previousSerial' FROM "AuditEvent" a
        WHERE a."restaurantId" = ${restaurantId} AND a.kind = 'terminal.serial.changed'
          AND a."targetId" = f."deviceId" AND a."occurredAt" >= ${HEALTH_WINDOW_START} AND a."occurredAt" > f."createdAt"
        ORDER BY a."occurredAt" LIMIT 1
      ), NULLIF(d."serialNumber", ''), 'mock:' || d."kushkiDeviceId") AS serial
      FROM "Order" o JOIN "Payment" p ON p."orderId" = o.id
      JOIN "FinancialOperation" f ON f.key = 'terminal:' || p.id
      JOIN "TerminalDevice" d ON d."kushkiDeviceId" = f."deviceId" AND d."restaurantId" = o."restaurantId"
      WHERE o."restaurantId" = ${restaurantId} AND p.method = 'kushki_card_terminal' AND f.kind = 'terminal'
        AND f."createdAt" >= ${HEALTH_WINDOW_START}
    ), candidates AS (
      SELECT DISTINCT serial FROM claims WHERE "gatewayTimedOutAt" IS NOT NULL
        ${busyPaymentId ? Prisma.sql`AND serial IN (SELECT serial FROM claims WHERE "paymentId" = ${busyPaymentId})` : Prisma.empty}
    ), affected AS (
      SELECT f.* FROM claims f JOIN candidates USING (serial)
    ), webhooks AS (
      SELECT f.*, w."eventId", w.type, w."createdAt" AS received,
        w.payload->>'message' AS message,
        -- Historical declines retain the provider body and the TYPE/CODE prefix
        -- from sync/charge, even when FinancialOperation.answerCode is null.
        upper(COALESCE(
          (w.payload #>> '{raw,failure,type}') || '/' || (w.payload #>> '{raw,failure,code}'),
          (w.payload #>> '{raw,type}') || '/' || (w.payload #>> '{raw,code}'),
          split_part(w.payload->>'message', ':', 1)
        )) = ${CLOUD_BUSY_ANSWER} AS cloud_busy
      FROM "KushkiWebhookEvent" w JOIN affected f ON f."paymentId" = w.payload->>'paymentId'
      WHERE (w."restaurantId" IS NULL OR w."restaurantId" = ${restaurantId}) AND w."processedAt" IS NOT NULL
        AND w."createdAt" >= ${HEALTH_WINDOW_START} AND w.type IN ('terminal.approved', 'terminal.declined')
    ), observations AS (
      SELECT serial, "paymentId", "answeredAt" AS at,
        CASE WHEN upper("answerCode") = ${CLOUD_BUSY_ANSWER} THEN 'cloud_busy' ELSE 'answered' END AS kind
      FROM affected WHERE "answeredAt" >= ${HEALTH_WINDOW_START}
      UNION ALL
      SELECT serial, "paymentId", CASE WHEN message = 'transaction_search_online'
        THEN COALESCE("gatewayTimedOutAt", "createdAt") ELSE received END,
        CASE WHEN type = 'terminal.declined' AND cloud_busy THEN 'cloud_busy' ELSE 'answered' END
      FROM webhooks
      WHERE type = 'terminal.approved' OR "eventId" LIKE 'cloudterm:' || "paymentId" || ':no:%'
        OR "eventId" LIKE 'cloudterm:' || "paymentId" || ':search-declined:%' OR "eventId" LIKE 'mock-%'
        OR (cloud_busy AND "eventId" LIKE 'cloudterm:' || "paymentId" || ':rejected:%')
      UNION ALL
      SELECT f.serial, f."paymentId", CASE WHEN a.diff->>'source' = 'transaction_search_online'
        THEN COALESCE(f."gatewayTimedOutAt", f."createdAt") ELSE a."occurredAt" END, 'answered'
      FROM "AuditEvent" a JOIN affected f ON f."paymentId" = a."targetId"
      WHERE a."restaurantId" = ${restaurantId} AND a.kind = 'payment.terminal_amount_mismatch' AND a."occurredAt" >= ${HEALTH_WINDOW_START}
    )
    SELECT serial, "gatewayTimedOutAt" AS at, 'timeout' AS kind, NULL::text AS "paymentId" FROM affected WHERE "gatewayTimedOutAt" IS NOT NULL
    UNION ALL
    SELECT serial, MAX(at) AS at, kind, NULL FROM observations WHERE kind = 'answered' GROUP BY serial, kind
    UNION ALL
    SELECT o.serial, MIN(o.at) AS at, o.kind, o."paymentId" FROM observations o
    JOIN affected f USING ("paymentId", serial)
    WHERE o.kind = 'cloud_busy' AND f."gatewayTimedOutAt" IS NULL
    GROUP BY o.serial, o."paymentId", o.kind
    UNION ALL
    SELECT a."targetId" AS serial, MAX(a."occurredAt") AS at, 'printed' AS kind, NULL
    FROM "AuditEvent" a JOIN candidates c ON c.serial = a."targetId"
    WHERE a."restaurantId" = ${restaurantId} AND a.kind = ${TERMINAL_PRINT_COMPLETED} AND a."occurredAt" >= ${HEALTH_WINDOW_START}
    GROUP BY a."targetId"`;
  const warnings = terminalWarnings(devices, evidence);
  if (!busyPaymentId) return warnings;
  const busy = evidence.find(event => event.paymentId === busyPaymentId && event.kind === "cloud_busy");
  return busy ? warnings.filter(w => busy.at.getTime() > Date.parse(w.since)) : [];
}

// Advisory only: a failed lookup must not hide a settled payment or interrupt polling.
export async function unresponsiveAfterBusy(restaurantId: string, paymentId: string) {
  try {
    return (await readTerminalWarnings(restaurantId, paymentId)).length > 0;
  } catch (cause) {
    console.warn("[terminal] health_lookup_failed", { paymentId, cause });
    return false;
  }
}
