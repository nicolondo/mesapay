import { secureApi } from "@/lib/secureApi";
import { creditNoteApi } from "@/lib/dian/creditNotes/api";
import { CreditNoteError } from "@/lib/dian/creditNotes/domain";
import { sendDianCreditNoteEmail } from "@/lib/dian/sendCreditNoteEmail";
export const dynamic = "force-dynamic";
export const POST = secureApi(async (_req: Request, {params}: {params: Promise<{id:string}>}) =>
  creditNoteApi(async ctx => {
    const result = await sendDianCreditNoteEmail((await params).id,ctx.restaurantId,{force:true});
    if(!result.ok) throw new CreditNoteError(result.reason,result.reason === "not_found" ? 404 : 400);
    return {sentTo:result.to,emailedAt:result.emailedAt};
  }));
