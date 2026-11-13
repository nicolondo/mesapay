import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { sourceReason, baseSourceKey, type TrackingSourceRow } from "./sources";
import { TrackingError } from "./errors";
import { entryPayloadHash } from "./fingerprint";
import type { TrackingAmounts } from "./calculation";

export async function trackingLock(tx: Prisma.TransactionClient, key: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`wallet-tracking:${key}`}))::text`;
}
type AccountHint = { id: string; scopeKey: string; trackingKey: string; mode: string; currency: string };
/** Caller holds the account lock. The original source key is unique across
 * account versions, and cumulative refund snapshots produce only a delta. */
export async function recordSourceInTx(tx: Prisma.TransactionClient, account: AccountHint, row: TrackingSourceRow) {
  const key = baseSourceKey(account.scopeKey,row);
  const original = await tx.walletTrackingEntry.findUnique({ where: { sourceKey: `${key}:charge` } });
  if (sourceReason(row,account.currency) || (original?.kind !== "historical" && (row.trackingKey !== account.trackingKey || row.mode !== account.mode))
    || (original && (original.accountId !== account.id || original.sourceAmountCents !== BigInt(row.amountCents)))) throw new TrackingError("tracking_source_ineligible");
  const shared = { accountId: account.id, sourceKind: row.source, sourceId: row.sourceId, currency: account.currency,
    occurredAt: row.occurredAt, dateBasis: row.dateBasis, evidence: "local_confirmed", sourceAmountCents: BigInt(row.amountCents) };
  if (!original) await tx.walletTrackingEntry.create({ data: { ...shared, sourceKey: `${key}:charge`, kind: "charge",
    amountCents: BigInt(row.amountCents), payloadHash: entryPayloadHash([key,"charge",row.amountCents,account.currency]), sourceRefundedCents: BigInt(0) } });
  const previous = await tx.walletTrackingEntry.aggregate({ where: { accountId: account.id, sourceKind: row.source, sourceId: row.sourceId }, _max: { sourceRefundedCents: true } });
  const refunded = previous._max.sourceRefundedCents ?? BigInt(0);
  const current = BigInt(row.refundedCents);
  if (current < refunded) throw new TrackingError("tracking_source_ineligible");
  if (current > refunded) await tx.walletTrackingEntry.create({ data: { ...shared, sourceKey: `${key}:refund:${current}`, kind: "refund",
    amountCents: current-refunded, payloadHash: entryPayloadHash([key,"refund",current.toString()]), sourceRefundedCents: current,
    occurredAt: new Date(), dateBasis: "record" } });
}
export async function trackingTotals(accountId: string): Promise<{ totals: TrackingAmounts; watermark: bigint }> {
  const [groups,last] = await Promise.all([
    db.walletTrackingEntry.groupBy({ by:["kind"], where:{accountId}, _sum:{amountCents:true} }),
    db.walletTrackingEntry.aggregate({where:{accountId},_max:{id:true}}),
  ]);
  const amounts = new Map(groups.map(g=>[g.kind,g._sum.amountCents ?? BigInt(0)]));
  return { totals: { chargesCents:amounts.get("charge")??BigInt(0), refundsCents:amounts.get("refund")??BigInt(0),
    registeredFeesCents:amounts.get("fee")??BigInt(0), effectiveOutgoingCents:BigInt(0),
    adjustmentsCents:amounts.get("adjustment")??BigInt(0), incorporatedHistoryCents:amounts.get("historical")??BigInt(0) },
    watermark:last._max.id??BigInt(0) };
}
