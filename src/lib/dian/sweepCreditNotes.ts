import { db } from "@/lib/db";
import { emitDianCreditNote } from "./emitCreditNote";
import { MAX_ATTEMPTS } from "./retry";

/** Fiscal reservations persist through failures. Rejected/abandoned notes are
 * never submitted by this queue. Pending documents are queried by CUDE first. */
export async function sweepCreditNotes(opts:{now?:Date;limit?:number;budgetMs?:number}={}) {
  const now=opts.now??new Date();
  const started=Date.now();
  const docs=await db.dianDocument.findMany({
    where:{kind:"credit_note",creditNote:{is:{abandonedAt:null}},AND:[
      {OR:[{state:{in:["to_send","sent","pending"]}},{state:"error",OR:[{attempts:{lt:MAX_ATTEMPTS}},{xmlZip:{not:null}}]}]},
      {OR:[{nextAttemptAt:null},{nextAttemptAt:{lte:now}}]},
      {OR:[{leaseExpiresAt:null},{leaseExpiresAt:{lte:now}}]},
    ]},
    select:{creditNoteId:true,restaurantId:true,attempts:true},orderBy:{createdAt:"asc"},take:opts.limit??10,
  });
  const summary={scanned:0,accepted:0,pending:0,rejected:0,error:0,blocked:0,skipped:0,truncated:false};
  for(const doc of docs) {
    if(Date.now()-started>=(opts.budgetMs??25_000)){summary.truncated=true;break;}
    if(!doc.creditNoteId)continue;
    summary.scanned++;
    try {
      const result=await emitDianCreditNote({creditNoteId:doc.creditNoteId,restaurantId:doc.restaurantId,...(doc.attempts>=MAX_ATTEMPTS?{mode:"status" as const}:{})});
      if(result.outcome==="not_found"||result.outcome==="already_emitted")summary.skipped++;
      else summary[result.outcome]++;
    } catch {summary.error++;}
  }
  return summary;
}
