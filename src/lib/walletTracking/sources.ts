import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { TrackingScope, TrackingSource } from "./contracts";

export type TrackingSourceRow = {
  source: TrackingSource; sourceId: string; occurredAt: Date; dateBasis: "payment" | "record";
  amountCents: number; refundedCents: number; currency: string | null; trackingKey: string | null;
  mode: string | null; providerRef: string | null; uncertain: boolean; duplicateReference?: boolean;
};
const METHODS = Prisma.sql`('kushki_card', 'kushki_apple_pay', 'kushki_google_pay', 'kushki_pse', 'kushki_card_terminal')`;
/** All-time, tenant-scoped source projection. PaymentLink(order) and applied
 * deposits/vouchers are intentionally absent so one collection is counted once. */
export function rawSourcesQuery(scope: TrackingScope): Prisma.Sql {
  if (scope.kind === "platform") return Prisma.sql`
    SELECT 'subscription'::text AS source, m.id AS "sourceId", m."createdAt" AS "occurredAt", 'record'::text AS "dateBasis",
      m."amountCents", 0::integer AS "refundedCents", m.currency, m."walletTrackingKey" AS "trackingKey",
      m."walletTrackingMode"::text AS mode, m."providerRef", false AS uncertain
    FROM "MembershipPayment" m WHERE m.method::text = 'kushki_card' AND m.kind IN ('initial','recurring')`;
  const tenant = scope.restaurantId;
  return Prisma.sql`
    SELECT 'order'::text AS source, p.id AS "sourceId", COALESCE(p."settledAt",p."createdAt") AS "occurredAt",
      CASE WHEN p."settledAt" IS NULL THEN 'record' ELSE 'payment' END AS "dateBasis", p."amountCents", p."refundedCents",
      p."walletTrackingCurrency" AS currency, p."walletTrackingKey" AS "trackingKey", p."walletTrackingMode"::text AS mode,
      p."providerRef", (p."reconciliationRequired" OR p."refundReservedCents" > 0) AS uncertain
    FROM "Payment" p JOIN "Order" o ON o.id=p."orderId"
    WHERE o."restaurantId"=${tenant} AND p.method::text IN ${METHODS} AND p.status::text IN ('approved','refunded')
    UNION ALL
    SELECT 'reservation', r.id, COALESCE(r."depositPaidAt",r."createdAt"),
      CASE WHEN r."depositPaidAt" IS NULL THEN 'record' ELSE 'payment' END, r."depositCents",
      CASE WHEN r."depositStatus"::text='refunded' THEN r."depositCents" ELSE 0 END,
      r."depositCurrency", r."depositTrackingKey", r."depositSourceMode"::text, r."depositTxId", false
    FROM "Reservation" r WHERE r."restaurantId"=${tenant} AND r."depositMethod"::text IN ${METHODS}
      AND r."depositStatus"::text IN ('paid','applied','forfeited','refunded') AND r."depositCents">0
    UNION ALL
    SELECT 'voucher', l.id, COALESCE(l."paidAt",l."createdAt"), CASE WHEN l."paidAt" IS NULL THEN 'record' ELSE 'payment' END,
      l."amountCents", 0, l.currency, l."walletTrackingKey", l."walletTrackingMode"::text, l."providerRef", false
    FROM "PaymentLink" l WHERE l."restaurantId"=${tenant} AND l.kind::text IN ('voucher_batch','voucher_statement')
      AND l.status::text='paid' AND l.method::text IN ${METHODS}`;
}
export function trackingSourcesQuery(scope: TrackingScope): Prisma.Sql {
  return Prisma.sql`SELECT base.*, (COUNT(*) OVER (PARTITION BY mode,"trackingKey","providerRef"))>1 AS "duplicateReference"
    FROM (${rawSourcesQuery(scope)}) base`;
}
/** Activation must not make concurrent collections/refunds part of both the
 * opening balance and the prospective ledger. This bounded scalar compares the
 * complete local projection on either side of the remote balance read. */
export async function trackingSourceEvidence(scope: TrackingScope, since: Date, client:Pick<Prisma.TransactionClient,"$queryRaw">=db) {
  const rows=await client.$queryRaw<{fingerprint:string;hasRecent:boolean}[]>(Prisma.sql`SELECT MD5(COALESCE(STRING_AGG(
    MD5(ROW(source,"sourceId","occurredAt","amountCents","refundedCents",currency,"trackingKey",mode,"providerRef",uncertain)::text),
    '' ORDER BY source,"sourceId"),'')) AS fingerprint,
    COALESCE(BOOL_OR("occurredAt">=${since.toISOString()}::timestamp),false) AS "hasRecent"
    FROM (${rawSourcesQuery(scope)}) sources`);
  return rows[0];
}
export function sourceReason(row: TrackingSourceRow, currency: string): string | null {
  if (!Number.isSafeInteger(row.amountCents) || row.amountCents <= 0 || !Number.isSafeInteger(row.refundedCents)
    || row.refundedCents < 0 || row.refundedCents > row.amountCents) return "invalid_amount";
  if (row.uncertain || row.duplicateReference || !row.providerRef?.trim()) return "source_not_confirmed";
  if (/^(mock[_:-]|manual:)/i.test(row.providerRef)) return "manual_or_mock";
  if (!row.currency) return "currency_unknown";
  if (row.currency !== currency) return "currency_mismatch";
  return null;
}
export function baseSourceKey(scopeKey: string, row: Pick<TrackingSourceRow,"source"|"sourceId">) {
  return `${scopeKey}:${row.source}:${row.sourceId}`;
}
type AccountHint = { id: string; scopeKey: string; startedAt: Date; currency: string; trackingKey: string; mode: string };
function preparedQuery(scope: TrackingScope, account: AccountHint, through: Date) {
  return Prisma.sql`WITH sources AS (${trackingSourcesQuery(scope)}), prepared AS (
    SELECT s.*, e.id AS "entryId", e."accountId" AS "entryAccountId", e.kind AS "entryKind", e."sourceAmountCents" AS "entrySourceAmount",
      COALESCE((SELECT MAX(r."sourceRefundedCents") FROM "WalletTrackingEntry" r
        WHERE r."accountId"=${account.id} AND r."sourceKind"=s.source AND r."sourceId"=s."sourceId"),0) AS "recordedRefunds"
    FROM sources s LEFT JOIN "WalletTrackingEntry" e ON e."sourceKey"=(${account.scopeKey} || ':' || s.source || ':' || s."sourceId" || ':charge')
    -- Prisma DateTime columns are UTC timestamp WITHOUT time zone. Bind UTC
    -- text explicitly; a timestamptz parameter would shift comparisons in Bogotá.
    WHERE s."occurredAt"<=${through.toISOString()}::timestamp AND (s."occurredAt">=${account.startedAt.toISOString()}::timestamp OR (e."accountId"=${account.id} AND e.kind='historical'))
  ), classified AS (SELECT *, (NOT uncertain AND NOT "duplicateReference" AND "providerRef" IS NOT NULL AND LENGTH(BTRIM("providerRef"))>0
    AND "providerRef" !~* '^(mock[_:-]|manual:)' AND "amountCents">0 AND "refundedCents">=0 AND "refundedCents"<="amountCents"
    AND currency=${account.currency} AND ("entryAccountId" IS NULL OR "entryAccountId"=${account.id})
    AND ("entryKind"='historical' OR ("trackingKey"=${account.trackingKey} AND mode=${account.mode}))
    AND ("entryId" IS NULL OR "entrySourceAmount"="amountCents") AND "recordedRefunds"<="refundedCents") IS TRUE AS eligible FROM prepared)`;
}
export async function loadChangedSources(scope: TrackingScope, account: AccountHint, through: Date, take = 100) {
  return db.$queryRaw<TrackingSourceRow[]>(Prisma.sql`${preparedQuery(scope,account,through)}
    SELECT source,"sourceId","occurredAt","dateBasis","amountCents","refundedCents",currency,"trackingKey",mode,"providerRef",uncertain,"duplicateReference"
    FROM classified WHERE eligible AND ("entryId" IS NULL OR "recordedRefunds"<"refundedCents")
    ORDER BY "occurredAt",source,"sourceId" LIMIT ${take}`);
}
export async function countExcludedSources(scope: TrackingScope, account: AccountHint, through: Date) {
  const rows = await db.$queryRaw<{ count: bigint }[]>(Prisma.sql`${preparedQuery(scope,account,through)} SELECT COUNT(*)::bigint AS count FROM classified WHERE NOT eligible`);
  const count = Number(rows[0]?.count ?? BigInt(0));
  if (!Number.isSafeInteger(count)) throw new Error("source_count_invalid");
  return count;
}
export async function sourceById(scope: TrackingScope, source: TrackingSource, sourceId: string, client: Pick<Prisma.TransactionClient,"$queryRaw"> = db) {
  const rows = await client.$queryRaw<TrackingSourceRow[]>(Prisma.sql`WITH sources AS (${trackingSourcesQuery(scope)})
    SELECT * FROM sources WHERE source=${source} AND "sourceId"=${sourceId} LIMIT 1`);
  return rows[0] ?? null;
}
export async function sourceHistoryPage(scope: TrackingScope, before: Date, after: { source: string; sourceId: string } | null, take: number) {
  return db.$queryRaw<TrackingSourceRow[]>(Prisma.sql`WITH sources AS (${trackingSourcesQuery(scope)}) SELECT * FROM sources
    WHERE "occurredAt"<${before.toISOString()}::timestamp ${after ? Prisma.sql`AND (source,"sourceId")>(${after.source},${after.sourceId})` : Prisma.empty}
    ORDER BY source,"sourceId" LIMIT ${take}`);
}
