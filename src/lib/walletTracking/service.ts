import "server-only";
import { randomUUID } from "node:crypto";
import type { WalletTrackingAccount, WalletBalanceSnapshot } from "@prisma/client";
import { db } from "@/lib/db";
import { walletBalance } from "@/lib/platformWallet/provider";
import type { TrackingScope, TrackingActor, TrackingView, TrackingTotals } from "./contracts";
import { resolveTrackingContext, scopeKey, type TrackingContext } from "./context";
import { TrackingError } from "./errors";
import { calculateTracking, safeTrackingCents } from "./calculation";
import { loadChangedSources, countExcludedSources, trackingSourceEvidence } from "./sources";
import { trackingLock, recordSourceInTx, trackingTotals } from "./store";
import { trackingOutgoing } from "./outgoing";
import { historicalSourceChanges, recordHistoricalObservations } from "./history";

const ZERO_TOTALS: TrackingTotals = { chargesCents:0,refundsCents:0,registeredFeesCents:0,effectiveOutgoingCents:0,adjustmentsCents:0,incorporatedHistoryCents:0 };
const BASE_REASONS = ["earlier_excluded","fees_not_automatically_known"];
const INTERVAL=5*60_000, STALE=15*60_000;
function emptyView(context?: Pick<TrackingContext,"mode"|"currency"|"trackingKey">, status: TrackingView["status"]="initializing"): TrackingView {
  return { trackingId:null,trackingKey:context?.trackingKey??null,mode:context?.mode??null,currency:context?.currency??null,
    startedAt:null,excludesEarlier:true,baselineAvailableCents:null,openingPendingCents:0,snapshotAt:null,lastComparedAt:null,status,
    estimatedPendingCents:null,signedDifferenceCents:null,historicalChangeToken:null,totals:{...ZERO_TOTALS},ambiguousOutgoingCount:0,excludedSourceCount:0,reasons:[...BASE_REASONS] };
}
export function trackingView(account: WalletTrackingAccount, snapshot: WalletBalanceSnapshot | null): TrackingView {
  const view=emptyView(account);
  const stale=!!account.lastErrorCode || !account.lastSuccessAt || Date.now()-account.lastSuccessAt.getTime()>STALE;
  const difference=snapshot?.signedDifferenceCents??null;
  const totals=snapshot ? Object.fromEntries(Object.keys(ZERO_TOTALS).map(key=>[key,safeTrackingCents(snapshot[key as keyof TrackingTotals])])) as TrackingTotals : {...ZERO_TOTALS};
  const status=snapshot?.status==="needs_review"?"needs_review":stale?"stale":snapshot?"active":"initializing";
  return {...view,trackingId:account.id,startedAt:account.startedAt.toISOString(),baselineAvailableCents:safeTrackingCents(account.baselineAvailableCents),
    openingPendingCents:safeTrackingCents(account.openingPendingCents),snapshotAt:snapshot?.observedAt.toISOString()??null,
    lastComparedAt:difference!==null?snapshot!.observedAt.toISOString():null,status,
    signedDifferenceCents:difference===null?null:safeTrackingCents(difference),
    historicalChangeToken:snapshot?.historicalChangeToken??null,
    estimatedPendingCents:difference===null||difference<BigInt(0)?null:safeTrackingCents(difference),totals,
    ambiguousOutgoingCount:snapshot?.ambiguousOutgoingCount??0,excludedSourceCount:snapshot?.excludedSourceCount??0,
    reasons:[...new Set([...BASE_REASONS,...(snapshot?.reasons??[]),...(account.lastErrorCode?[account.lastErrorCode]:[]),...(stale?["tracking_stale"]:[])])]};
}
async function accountView(account: WalletTrackingAccount) {
  const snapshot=await db.walletBalanceSnapshot.findFirst({where:{accountId:account.id},orderBy:[{observedAt:"desc"},{id:"desc"}]});
  return trackingView(account,snapshot);
}
export async function getWalletTracking(scope: TrackingScope): Promise<TrackingView> {
  let context: TrackingContext;
  try { context=await resolveTrackingContext(scope); }
  catch(error) {
    if(error instanceof TrackingError && error.code==="tracking_unsupported") return emptyView(undefined,"unsupported");
    const previous=await db.walletTrackingAccount.findFirst({where:{scopeKey:scopeKey(scope),active:true},orderBy:{createdAt:"desc"}});
    return previous?accountView({...previous,lastErrorCode:"account_changed"}):emptyView(undefined,"unavailable");
  }
  const account=await db.walletTrackingAccount.findUnique({where:{trackingKey:context.trackingKey}});
  return account?accountView(account):emptyView(context);
}
async function activate(scope:TrackingScope, context: TrackingContext, availableCents: number, observedAt: Date, actor: TrackingActor, sourceFingerprint:string) {
  return db.$transaction(async tx=>{
    await trackingLock(tx,context.scopeKey);
    const existing=await tx.walletTrackingAccount.findUnique({where:{trackingKey:context.trackingKey}});
    if(existing) return existing;
    await tx.walletTrackingAccount.updateMany({where:{scopeKey:context.scopeKey,active:true},data:{active:false}});
    const account=await tx.walletTrackingAccount.create({data:{scopeKey:context.scopeKey,scopeKind:context.scopeKind,restaurantId:context.restaurantId,
      trackingKey:context.trackingKey,walletAccountFingerprint:context.walletAccountFingerprint,platformWalletAccountId:context.platformWalletAccountId,
      mode:context.mode,currency:context.currency,startedAt:observedAt,baselineAvailableCents:BigInt(availableCents)}});
    await recordHistoricalObservations(tx,scope,account,actor,"baseline");
    if((await trackingSourceEvidence(scope,observedAt,tx)).fingerprint!==sourceFingerprint) throw new TrackingError("tracking_busy");
    await tx.auditEvent.create({data:{restaurantId:context.restaurantId,actorUserId:actor.id,actorEmail:actor.email,actorRole:actor.role??"system",
      kind:"wallet.tracking.activate",targetType:"wallet_tracking",targetId:account.id,summary:"Wallet tracking",
      diff:{baselineAvailableCents:availableCents,openingPendingCents:0,excludesEarlier:true,mode:context.mode,currency:context.currency}}});
    return account;
  });
}
async function claim(account: WalletTrackingAccount, token: string) {
  await db.$transaction(async tx=>{
    await trackingLock(tx,account.scopeKey);
    const current=await tx.walletTrackingAccount.findUniqueOrThrow({where:{id:account.id}});
    if(current.leaseUntil && current.leaseUntil>new Date()) throw new TrackingError("tracking_busy",409);
    await tx.walletTrackingAccount.updateMany({where:{scopeKey:account.scopeKey,active:true,id:{not:account.id}},data:{active:false}});
    await tx.walletTrackingAccount.update({where:{id:account.id},data:{active:true,leaseToken:token,leaseUntil:new Date(Date.now()+120_000)}});
  });
}
async function scan(scope: TrackingScope, account: WalletTrackingAccount, through: Date) {
  const deadline=Date.now()+20_000;
  for(let page=0;page<15 && Date.now()<deadline;page++) {
    const rows=await loadChangedSources(scope,account,through);
    if(!rows.length) return true;
    await db.$transaction(async tx=>{
      await trackingLock(tx,account.scopeKey);
      for(const row of rows) await recordSourceInTx(tx,account,row);
    },{timeout:15_000});
  }
  return !(await loadChangedSources(scope,account,through,1)).length;
}
async function readBalance(context: TrackingContext) {
  try { return await walletBalance(context.payoutCredentials); }
  catch { throw new TrackingError("tracking_balance_unavailable",502); }
}
export async function syncWalletTracking(scope: TrackingScope, actor: TrackingActor): Promise<TrackingView> {
  const context=await resolveTrackingContext(scope);
  let account=await db.walletTrackingAccount.findUnique({where:{trackingKey:context.trackingKey}});
  let baselineBalance: Awaited<ReturnType<typeof readBalance>> | null=null;
  let baselineOutgoing: Awaited<ReturnType<typeof trackingOutgoing>> | null=null;
  let baselineRequestedAt: Date | null=null;
  if(!account) {
    // Starting while an old transfer may still debit the wallet would bake an
    // unknown opening liability into every later estimate.
    baselineRequestedAt=new Date();
    const openingContext={...context,startedAt:baselineRequestedAt};
    const outgoing=await trackingOutgoing(openingContext);
    if(outgoing.ambiguous) throw new TrackingError("tracking_busy");
    const sourceEvidence=await trackingSourceEvidence(scope,baselineRequestedAt);
    baselineBalance=await readBalance(context);
    const [afterOutgoing,afterSources]=await Promise.all([trackingOutgoing(openingContext),trackingSourceEvidence(scope,baselineRequestedAt)]);
    if(afterOutgoing.ambiguous || afterOutgoing.amountCents>BigInt(0) || afterSources.hasRecent || sourceEvidence.fingerprint!==afterSources.fingerprint) throw new TrackingError("tracking_busy");
    baselineOutgoing=afterOutgoing;
    account=await activate(scope,context,baselineBalance.availableCents,baselineRequestedAt,actor,sourceEvidence.fingerprint);
  }
  const token=randomUUID();
  await claim(account,token);
  try {
    const requestedAt=baselineRequestedAt??new Date();
    const outgoingBefore=baselineOutgoing??await trackingOutgoing(account);
    const balance=baselineBalance??await readBalance(context);
    const observedAt=new Date();
    const complete=await scan(scope,account,observedAt);
    const [{totals,watermark},outgoing,excluded,historical]=await Promise.all([
      trackingTotals(account.id),trackingOutgoing(account),countExcludedSources(scope,account,observedAt),historicalSourceChanges(scope,account),
    ]);
    const current=await resolveTrackingContext(scope);
    if(current.trackingKey!==context.trackingKey) throw new TrackingError("tracking_account_changed");
    const effectiveTotals={...totals,effectiveOutgoingCents:outgoing.amountCents};
    const outgoingUnstable=outgoingBefore.ambiguous>0 || outgoingBefore.fingerprint!==outgoing.fingerprint;
    // Excluded post-cut collections make the total incomplete, even though their
    // money may already be present in the provider balance.
    const calculated=calculateTracking({...effectiveTotals,baselineAvailableCents:account.baselineAvailableCents,
      openingPendingCents:account.openingPendingCents,availableCents:BigInt(balance.availableCents),blocked:!complete||outgoing.ambiguous>0||outgoingUnstable||excluded>0||historical.count>0});
    const reasons=[...(!complete?["source_scan_incomplete"]:[]),...(outgoing.ambiguous||outgoingUnstable?["ambiguous_outgoing"]:[]),
      ...(excluded?["sources_excluded"]:[]),...(historical.count?["historical_sources_changed"]:[]),...(calculated.signedDifferenceCents!==null&&calculated.signedDifferenceCents<BigInt(0)?["negative_difference"]:[])];
    await db.$transaction(async tx=>{
      await trackingLock(tx,account!.scopeKey);
      const owned=await tx.walletTrackingAccount.updateMany({where:{id:account!.id,leaseToken:token,leaseUntil:{gt:new Date()}},
        data:{lastSuccessAt:observedAt,lastErrorCode:null,nextCheckAt:new Date(Date.now()+INTERVAL)}});
      if(!owned.count) throw new TrackingError("tracking_busy");
      await tx.walletBalanceSnapshot.create({data:{accountId:account!.id,runKey:token,requestedAt,observedAt,
        providerBalanceDate:balance.balanceDate?new Date(balance.balanceDate):null,availableCents:BigInt(balance.availableCents),ledgerWatermark:watermark,
        ...effectiveTotals,signedDifferenceCents:calculated.signedDifferenceCents,status:calculated.status,
        ambiguousOutgoingCount:outgoing.ambiguous,excludedSourceCount:excluded,historicalChangeToken:historical.token,reasons}});
    });
  } catch(error) {
    const code=error instanceof TrackingError&&error.code==="tracking_account_changed"?"account_changed":
      error instanceof TrackingError&&error.code==="tracking_balance_unavailable"?"balance_unavailable":"source_scan_incomplete";
    await db.walletTrackingAccount.updateMany({where:{id:account.id,leaseToken:token},data:{lastErrorCode:code,nextCheckAt:new Date(Date.now()+INTERVAL)}});
    if(error instanceof TrackingError&&error.code==="tracking_account_changed") throw error;
  } finally {
    await db.walletTrackingAccount.updateMany({where:{id:account.id,leaseToken:token},data:{leaseToken:null,leaseUntil:null}});
  }
  return accountView(await db.walletTrackingAccount.findUniqueOrThrow({where:{id:account.id}}));
}

export { adjustWalletTracking, listTrackingHistoryCandidates, incorporateTrackingHistory, findWalletTrackingOperation } from "./actions";
export { runWalletTrackingBatch } from "./batch";
