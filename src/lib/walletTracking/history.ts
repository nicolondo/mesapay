import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { rawSourcesQuery } from "./sources";
import { entryPayloadHash } from "./fingerprint";
import { safeTrackingCents } from "./calculation";
import type { TrackingScope, TrackingActor, TrackingSource } from "./contracts";

type Account={id:string;startedAt:Date;currency:string};
type Client=Pick<Prisma.TransactionClient,"$queryRaw"|"$executeRaw">;
/** Zero-valued observations are evidence, never collections. Incorporated
 * sources instead use their explicit remainder and ordinary refund deltas. */
function historicalChanges(scope:TrackingScope,account:Account) {
  return Prisma.sql`WITH current_sources AS (
    SELECT s.*, MD5(ROW("amountCents","refundedCents",currency,mode,"trackingKey","providerRef",uncertain)::text) AS hash
    FROM (${rawSourcesQuery(scope)}) s WHERE "occurredAt"<${account.startedAt.toISOString()}::timestamp
  ), previous AS (
    SELECT DISTINCT ON ("sourceKind","sourceId") "sourceKind" AS source,"sourceId","payloadHash" AS hash,
      "sourceAmountCents" AS "amountCents","sourceRefundedCents" AS "refundedCents",currency,"occurredAt","dateBasis"
    FROM "WalletTrackingEntry" WHERE "accountId"=${account.id} AND kind='observation'
    ORDER BY "sourceKind","sourceId",id DESC
  ), compared AS (
    SELECT COALESCE(c.source,p.source) AS source,COALESCE(c."sourceId",p."sourceId") AS "sourceId",
      COALESCE(c.hash,'missing') AS hash,p.hash AS "previousHash",COALESCE(c."amountCents",p."amountCents") AS "amountCents",
      COALESCE(c."refundedCents",p."refundedCents") AS "refundedCents",COALESCE(c.currency,p.currency,${account.currency}) AS currency,
      COALESCE(c."occurredAt",p."occurredAt") AS "occurredAt",COALESCE(c."dateBasis",p."dateBasis") AS "dateBasis"
    FROM current_sources c FULL OUTER JOIN previous p ON c.source=p.source AND c."sourceId"=p."sourceId"
  ), changed AS (
    SELECT x.* FROM compared x WHERE hash IS DISTINCT FROM "previousHash" AND NOT EXISTS (
      SELECT 1 FROM "WalletTrackingEntry" e WHERE e."accountId"=${account.id} AND e.kind='historical'
      AND e."sourceKind"=x.source AND e."sourceId"=x."sourceId")
  )`;
}
export async function historicalSourceChanges(scope:TrackingScope,account:Account,client:Client=db) {
  const rows=await client.$queryRaw<{count:bigint;fingerprint:string}[]>(Prisma.sql`${historicalChanges(scope,account)}
    SELECT COUNT(*)::bigint AS count,MD5(COALESCE(STRING_AGG(ROW(source,"sourceId",hash,"previousHash")::text,'' ORDER BY source,"sourceId"),'')) AS fingerprint FROM changed`);
  const count=Number(rows[0].count);
  if(!Number.isSafeInteger(count)) throw new Error("source_count_invalid");
  return {count,token:count?entryPayloadHash([account.id,rows[0].fingerprint]):null};
}
export async function changedHistoricalSources(scope:TrackingScope,account:Account,sources:{source:TrackingSource;sourceId:string}[],client:Client=db) {
  if(!sources.length) return new Set<string>();
  const rows=await client.$queryRaw<{source:TrackingSource;sourceId:string}[]>(Prisma.sql`${historicalChanges(scope,account)} SELECT source,"sourceId" FROM changed
    WHERE ${Prisma.join(sources.map(source=>Prisma.sql`(source=${source.source} AND "sourceId"=${source.sourceId})`)," OR ")}`);
  return new Set(rows.map(row=>`${row.source}:${row.sourceId}`));
}
/** The declaration refers to the original cutoff, not today's refunded total.
 * Later observations remain audit evidence and cannot reduce this opening cap. */
export async function openingHistoryLimits(accountId:string,sources:{source:TrackingSource;sourceId:string;amountCents:number;refundedCents:number}[],client:Client=db) {
  const limits=new Map(sources.map(source=>[`${source.source}:${source.sourceId}`,Math.max(0,source.amountCents-source.refundedCents)]));
  if(!sources.length) return limits;
  const first=await client.$queryRaw<{source:string;sourceId:string;amount:bigint;refunded:bigint}[]>(Prisma.sql`
    SELECT DISTINCT ON ("sourceKind","sourceId") "sourceKind" AS source,"sourceId","sourceAmountCents" AS amount,"sourceRefundedCents" AS refunded
    FROM "WalletTrackingEntry" WHERE "accountId"=${accountId} AND kind='observation'
      AND (${Prisma.join(sources.map(source=>Prisma.sql`("sourceKind"=${source.source} AND "sourceId"=${source.sourceId})`)," OR ")})
    ORDER BY "sourceKind","sourceId",id ASC`);
  for(const row of first) limits.set(`${row.source}:${row.sourceId}`,safeTrackingCents(row.amount>row.refunded?row.amount-row.refunded:BigInt(0)));
  return limits;
}
/** Caller holds the tracking lock. Append only changed observations, retaining
 * both the previous state and the reviewed replacement in the audit ledger. */
export async function recordHistoricalObservations(client:Client,scope:TrackingScope,account:Account,actor:TrackingActor,reason:string) {
  return client.$executeRaw(Prisma.sql`${historicalChanges(scope,account)}
    INSERT INTO "WalletTrackingEntry" ("accountId","sourceKey","sourceKind","sourceId",kind,"amountCents",currency,"payloadHash",
      "sourceAmountCents","sourceRefundedCents","occurredAt","recordedAt","dateBasis",evidence,"actorId","actorEmail",reason)
    SELECT ${account.id},${account.id}||':observation:'||source||':'||"sourceId"||':'||COALESCE("previousHash",'initial')||':'||hash||':'||gen_random_uuid()::text,
      source,"sourceId",'observation',0,currency,hash,"amountCents","refundedCents","occurredAt",CURRENT_TIMESTAMP AT TIME ZONE 'UTC',"dateBasis",'local_observation',
      ${actor.id??null},${actor.email},${reason} FROM changed`);
}
