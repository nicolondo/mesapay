import "server-only";
import { db } from "@/lib/db";
import type { WalletTrackingAccount } from "@prisma/client";
import { entryPayloadHash } from "./fingerprint";

/** Only verified transfers from this exact wallet version are deductible.
 * Pending operations are a stop signal, never guessed from settledAt. */
export async function trackingOutgoing(account: Pick<WalletTrackingAccount,"scopeKind"|"restaurantId"|"startedAt"|"walletAccountFingerprint"|"mode"|"currency"|"platformWalletAccountId">) {
  const common = { id:true, amountCents:true, currency:true, status:true, walletAccountFingerprint:true, providerVerifiedAt:true, createdAt:true } as const;
  const rows = account.scopeKind === "platform"
    ? await db.platformPayout.findMany({ where:{OR:[{createdAt:{gte:account.startedAt}},{status:{in:["submitting","initialized","unknown"]}}]},
      select:{...common,accountId:true,account:{select:{mode:true}}} })
    : await db.payout.findMany({ where:{restaurantId:account.restaurantId!,OR:[{createdAt:{gte:account.startedAt}},{status:{in:["submitting","initialized","unknown"]}}]},
      select:{...common,sourceMode:true} });
  let amount=BigInt(0), ambiguous=0;
  const evidence: string[]=[];
  for(const row of rows) {
    const mode="account" in row ? row.account.mode : row.sourceMode;
    const matches=row.walletAccountFingerprint===account.walletAccountFingerprint && mode===account.mode && row.currency===account.currency;
    if(row.walletAccountFingerprint && !matches) continue;
    if(!row.walletAccountFingerprint && "accountId" in row && row.accountId!==account.platformWalletAccountId) continue;
    evidence.push(JSON.stringify([row.id,row.status,String(row.amountCents),row.providerVerifiedAt?.toISOString()??null]));
    if(["submitting","initialized","unknown"].includes(row.status)) { ambiguous++; continue; }
    if(row.createdAt<account.startedAt) continue;
    if(!matches) { ambiguous++; continue; }
    if(row.status==="approved") {
      if(!row.providerVerifiedAt) { ambiguous++; continue; }
      amount+=BigInt(row.amountCents);
    }
  }
  return { amountCents:amount, ambiguous, fingerprint:entryPayloadHash(evidence.sort()) };
}
