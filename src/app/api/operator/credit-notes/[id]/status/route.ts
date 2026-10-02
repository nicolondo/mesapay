import { secureApi } from "@/lib/secureApi";
import { creditNoteApi } from "@/lib/dian/creditNotes/api";
import { CreditNoteError } from "@/lib/dian/creditNotes/domain";
import { emitDianCreditNote } from "@/lib/dian/emitCreditNote";
export const dynamic = "force-dynamic";
export const POST = secureApi(async (_req: Request, {params}: {params: Promise<{id:string}>}) =>
  creditNoteApi(async ctx => {
    const result = await emitDianCreditNote({creditNoteId:(await params).id,restaurantId:ctx.restaurantId,mode:"status"});
    if(result.outcome === "not_found") throw new CreditNoteError("not_found",404);
    if(result.outcome === "blocked") throw new CreditNoteError(result.reason ?? "transport_error",400);
    return result;
  }));
