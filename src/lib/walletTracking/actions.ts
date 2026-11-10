import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { TrackingScope, TrackingActor, TrackingAdjustmentInput, TrackingHistoryInput, TrackingHistoryQuery, TrackingHistoryPage } from "./contracts";
import { resolveTrackingContext, scopeKey } from "./context";
import { TrackingError } from "./errors";
import { trackingLock } from "./store";
import { sourceById, sourceHistoryPage, sourceReason, baseSourceKey } from "./sources";
import { entryPayloadHash } from "./fingerprint";
import { safeTrackingCents } from "./calculation";
import { getWalletTracking, syncWalletTracking } from "./service";
import { changedHistoricalSources, historicalSourceChanges, openingHistoryLimits, recordHistoricalObservations } from "./history";

const money=z.number().int().safe();
const common={trackingId:z.string().min(1).max(100),idempotencyKey:z.string().uuid(),reason:z.string().trim().min(5).max(1000)};
export const trackingAdjustmentSchema=z.object({...common,kind:z.enum(["fee","external_credit","external_debit","correction"]),amountCents:money,
  acknowledgeHistoricalChanges:z.boolean().optional(),historicalChangeToken:z.string().regex(/^[a-f0-9]{64}$/).optional()})
  .refine(v=>(v.amountCents!==0&&(v.kind==="correction"||v.amountCents>0)||v.kind==="correction"&&v.amountCents===0&&v.acknowledgeHistoricalChanges===true&&!!v.historicalChangeToken)
    && (!v.acknowledgeHistoricalChanges||!!v.historicalChangeToken));
export const trackingHistorySchema=z.object({...common,source:z.enum(["order","subscription","reservation","voucher"]),sourceId:z.string().min(1).max(100),remainingCents:money.positive()});
const operationKey=(scope:TrackingScope,key:string)=>`${scopeKey(scope)}:operation:${key}`;
async function activeForMutation(scope:TrackingScope,id:string) {
  const context=await resolveTrackingContext(scope);
  const account=await db.walletTrackingAccount.findUnique({where:{trackingKey:context.trackingKey}});
  if(!account||account.id!==id) throw new TrackingError("tracking_account_changed");
  return account;
}
async function mutationGuard(tx:Prisma.TransactionClient,scope:TrackingScope,account:{id:string;scopeKey:string;trackingKey:string},key:string,hash:string) {
  await trackingLock(tx,account.scopeKey);
  const replay=await tx.walletTrackingEntry.findUnique({where:{operationKey:key}});
  if(replay) {
    if(replay.accountId!==account.id||replay.payloadHash!==hash) throw new TrackingError("idempotency_conflict");
    return true;
  }
  const current=await tx.walletTrackingAccount.findUniqueOrThrow({where:{id:account.id}});
  if(!current.active) throw new TrackingError("tracking_account_changed");
  if(current.leaseUntil&&current.leaseUntil>new Date()) throw new TrackingError("tracking_busy");
  // Settings writes take row locks too. Hold a short shared lock while checking
  // identity and writing the adjustment, never while contacting the provider.
  await tx.$queryRaw`SELECT id FROM "PlatformConfig" WHERE id='singleton' FOR SHARE`;
  if(scope.kind==="merchant") await tx.$queryRaw`SELECT id FROM "Restaurant" WHERE id=${scope.restaurantId} FOR SHARE`;
  if((await resolveTrackingContext(scope)).trackingKey!==account.trackingKey) throw new TrackingError("tracking_account_changed");
  return false;
}
async function audit(tx:Prisma.TransactionClient,account:{id:string;restaurantId:string|null},actor:TrackingActor,kind:string,amountCents:number) {
  await tx.walletTrackingAccount.update({where:{id:account.id},data:{lastErrorCode:"source_scan_incomplete",nextCheckAt:new Date()}});
  await tx.auditEvent.create({data:{restaurantId:account.restaurantId,actorUserId:actor.id,actorEmail:actor.email,actorRole:actor.role??"operator",
    kind,targetType:"wallet_tracking",targetId:account.id,summary:"Wallet tracking",diff:{amountCents}}});
}
async function updatedView(scope:TrackingScope,actor:TrackingActor) {
  try { return await syncWalletTracking(scope,actor); }
  catch { return getWalletTracking(scope); }
}
export async function adjustWalletTracking(scope:TrackingScope,input:TrackingAdjustmentInput,actor:TrackingActor) {
  const parsed=trackingAdjustmentSchema.safeParse(input);
  if(!parsed.success) throw new TrackingError("invalid_payload",400);
  const value=parsed.data, account=await activeForMutation(scope,value.trackingId), key=operationKey(scope,value.idempotencyKey);
  const hash=entryPayloadHash(["adjustment",account.id,value.kind,value.amountCents,value.reason,value.acknowledgeHistoricalChanges??false,value.historicalChangeToken??null]);
  await db.$transaction(async tx=>{
    if(await mutationGuard(tx,scope,account,key,hash)) return;
    if(value.acknowledgeHistoricalChanges) {
      const changes=await historicalSourceChanges(scope,account,tx);
      if(!changes.token||changes.token!==value.historicalChangeToken) throw new TrackingError("tracking_history_changed");
      await recordHistoricalObservations(tx,scope,account,actor,value.reason);
    }
    const amount=value.kind==="external_debit"?-value.amountCents:value.amountCents;
    await tx.walletTrackingEntry.create({data:{accountId:account.id,sourceKey:key,operationKey:key,sourceKind:"adjustment",sourceId:value.idempotencyKey,
      kind:value.kind==="fee"?"fee":"adjustment",amountCents:BigInt(amount),currency:account.currency,payloadHash:hash,
      occurredAt:new Date(),dateBasis:"record",evidence:"operator_declared",actorId:actor.id,actorEmail:actor.email,reason:value.reason}});
    await audit(tx,account,actor,"wallet.tracking.adjust",amount);
    if(value.acknowledgeHistoricalChanges) await audit(tx,account,actor,"wallet.tracking.history.review",0);
  },{isolationLevel:"RepeatableRead"});
  return updatedView(scope,actor);
}
export async function incorporateTrackingHistory(scope:TrackingScope,input:TrackingHistoryInput,actor:TrackingActor) {
  const parsed=trackingHistorySchema.safeParse(input);
  if(!parsed.success) throw new TrackingError("invalid_payload",400);
  const value=parsed.data, account=await activeForMutation(scope,value.trackingId), key=operationKey(scope,value.idempotencyKey);
  const hash=entryPayloadHash(["history",account.id,value.source,value.sourceId,value.remainingCents,value.reason]);
  await db.$transaction(async tx=>{
    if(await mutationGuard(tx,scope,account,key,hash)) return;
    const row=await sourceById(scope,value.source,value.sourceId,tx);
    if(!row) throw new TrackingError("tracking_source_not_found",404);
    if(sourceReason(row,account.currency)||row.occurredAt>=account.startedAt
      ||(row.trackingKey!==null&&row.trackingKey!==account.trackingKey)||(row.mode!==null&&row.mode!==account.mode)) throw new TrackingError("tracking_source_ineligible");
    const maximum=(await openingHistoryLimits(account.id,[row],tx)).get(`${row.source}:${row.sourceId}`)!;
    if(value.remainingCents>maximum) throw new TrackingError("tracking_source_ineligible");
    if((await changedHistoricalSources(scope,account,[row],tx)).size) throw new TrackingError("tracking_history_changed");
    const sourceKey=`${baseSourceKey(account.scopeKey,row)}:charge`;
    if(await tx.walletTrackingEntry.findUnique({where:{sourceKey}})) throw new TrackingError("tracking_source_ineligible");
    await tx.walletTrackingEntry.create({data:{accountId:account.id,sourceKey,operationKey:key,sourceKind:row.source,sourceId:row.sourceId,
      kind:"historical",amountCents:BigInt(value.remainingCents),currency:account.currency,payloadHash:hash,
      sourceAmountCents:BigInt(row.amountCents),sourceRefundedCents:BigInt(row.refundedCents),occurredAt:row.occurredAt,dateBasis:row.dateBasis,
      evidence:"operator_declared",actorId:actor.id,actorEmail:actor.email,reason:value.reason}});
    await audit(tx,account,actor,"wallet.tracking.history",value.remainingCents);
  },{isolationLevel:"RepeatableRead"});
  return updatedView(scope,actor);
}
export async function listTrackingHistoryCandidates(scope:TrackingScope,query:TrackingHistoryQuery={}):Promise<TrackingHistoryPage> {
  const context=await resolveTrackingContext(scope);
  const account=await db.walletTrackingAccount.findUnique({where:{trackingKey:context.trackingKey}});
  if(!account) return {trackingId:null,candidates:[],nextCursor:null};
  const limit=query.limit??20;
  if(!Number.isInteger(limit)||limit<1||limit>50) throw new TrackingError("invalid_payload",400);
  let after:{source:string;sourceId:string}|null=null;
  if(query.cursor) {
    try {
      if(query.cursor.length>500) throw new Error("cursor");
      const cursor=z.object({a:z.string(),s:z.enum(["order","subscription","reservation","voucher"]),i:z.string().min(1).max(100)})
        .parse(JSON.parse(Buffer.from(query.cursor,"base64url").toString("utf8")));
      if(cursor.a!==account.id) throw new Error("cursor");
      after={source:cursor.s,sourceId:cursor.i};
    } catch {throw new TrackingError("invalid_payload",400);}
  }
  const rows=await sourceHistoryPage(scope,account.startedAt,after,limit+1);
  const visible=rows.slice(0,limit);
  const changed=await changedHistoricalSources(scope,account,visible);
  const openingLimits=await openingHistoryLimits(account.id,visible);
  const entries=await db.walletTrackingEntry.findMany({where:{sourceKey:{in:visible.map(row=>`${baseSourceKey(account.scopeKey,row)}:charge`)}},select:{sourceKey:true,amountCents:true}});
  const indexed=new Map(entries.map(e=>[e.sourceKey,e.amountCents]));
  const candidates=visible.map(row=>{
    const incorporated=indexed.get(`${baseSourceKey(account.scopeKey,row)}:charge`);
    const reason=sourceReason(row,account.currency)??(changed.has(`${row.source}:${row.sourceId}`)?"historical_sources_changed":incorporated!==undefined?"already_incorporated":
      row.trackingKey!==null&&row.trackingKey!==account.trackingKey||row.mode!==null&&row.mode!==account.mode?"account_mismatch":
      !row.trackingKey?"account_not_verified":null);
    return {source:row.source,sourceId:row.sourceId,occurredAt:row.occurredAt.toISOString(),dateBasis:row.dateBasis,
      amountCents:row.amountCents,refundedCents:row.refundedCents,currency:row.currency,maxOpeningPendingCents:openingLimits.get(`${row.source}:${row.sourceId}`)!,eligible:!reason||reason==="account_not_verified",reason,
      incorporatedCents:incorporated===undefined?null:safeTrackingCents(incorporated)};
  });
  const last=visible.at(-1);
  return {trackingId:account.id,candidates,nextCursor:rows.length>limit&&last?Buffer.from(JSON.stringify({a:account.id,s:last.source,i:last.sourceId})).toString("base64url"):null};
}
export async function findWalletTrackingOperation(scope:TrackingScope,idempotencyKey:string):Promise<boolean> {
  if(!z.string().uuid().safeParse(idempotencyKey).success) throw new TrackingError("invalid_payload",400);
  const key=scopeKey(scope);
  const entry=await db.walletTrackingEntry.findUnique({where:{operationKey:operationKey(scope,idempotencyKey)},select:{account:{select:{scopeKey:true}}}});
  return entry?.account.scopeKey===key;
}
