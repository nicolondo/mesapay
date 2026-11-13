import "server-only";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { trackingLock } from "./store";
import type { TrackingBatchResult, TrackingScope } from "./contracts";
import { TrackingError } from "./errors";
import { syncWalletTracking } from "./service";
import { scopeKey } from "./context";

export async function runWalletTrackingBatch():Promise<TrackingBatchResult> {
  const result:TrackingBatchResult={scanned:0,synced:0,failed:0,busy:0,truncated:false};
  const token=randomUUID(),deadline=Date.now()+40_000;
  const cursor=await db.$transaction(async tx=>{
    await trackingLock(tx,"batch");
    const job=await tx.walletTrackingJob.upsert({where:{id:"singleton"},create:{id:"singleton"},update:{}});
    if(job.leaseUntil&&job.leaseUntil>new Date()) return undefined;
    await tx.walletTrackingJob.update({where:{id:job.id},data:{leaseToken:token,leaseUntil:new Date(Date.now()+120_000)}});
    return job.restaurantCursor;
  });
  if(cursor===undefined) return {...result,busy:1};
  async function run(scope:TrackingScope) {
    result.scanned++;
    const last=await db.walletTrackingAccount.findFirst({where:{scopeKey:scopeKey(scope),active:true},orderBy:{createdAt:"desc"},select:{nextCheckAt:true}});
    if(last&&last.nextCheckAt>new Date()) return;
    try {
      const view=await syncWalletTracking(scope,{email:"system",role:"system"});
      if(view.status==="stale"||view.status==="unavailable") result.failed++; else result.synced++;
    } catch(error) {
      if(error instanceof TrackingError&&error.code==="tracking_busy") result.busy++; else result.failed++;
    }
  }
  try {
    const platform=await db.platformConfig.findUnique({where:{id:"singleton"},select:{platformWalletAccountId:true}});
    if(platform?.platformWalletAccountId) await run({kind:"platform"});
    const restaurants=await db.restaurant.findMany({where:{country:"CO",kushkiPrivateKeyEnc:{not:null},...(cursor?{id:{gt:cursor}}:{})},
      select:{id:true},orderBy:{id:"asc"},take:21});
    let last=cursor;
    for(const tenant of restaurants.slice(0,20)) {
      // Reserve one merchant slot even when the platform consumed the soft
      // deadline. Each sync is bounded; two worst-case syncs fit the 120s lease.
      if(last!==cursor && Date.now()>=deadline) {result.truncated=true;break;}
      await run({kind:"merchant",restaurantId:tenant.id});
      last=tenant.id;
    }
    const finished=!result.truncated&&restaurants.length<=20;
    result.truncated=result.truncated||restaurants.length>20;
    await db.walletTrackingJob.updateMany({where:{id:"singleton",leaseToken:token},data:{restaurantCursor:finished?null:last}});
  } finally {
    await db.walletTrackingJob.updateMany({where:{id:"singleton",leaseToken:token},data:{leaseToken:null,leaseUntil:null}});
  }
  return result;
}
