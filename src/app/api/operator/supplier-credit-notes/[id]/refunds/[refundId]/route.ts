import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { deleteCreditRefund } from "@/lib/erp/supplierCreditNoteService";
import { CREDIT_NOTE_GATE, creditErrorResponse } from "@/lib/erp/supplierCreditNoteApi";

export const dynamic = "force-dynamic";

/** Corrige un reintegro mal registrado (sólo con su mes contable abierto). */
async function DELETEHandler(_req: Request, { params }: { params: Promise<{ id: string; refundId: string }> }) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { id, refundId } = await params;
  try {
    await deleteCreditRefund(ctx.restaurantId, id, refundId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return creditErrorResponse(err);
  }
}

export const DELETE = secureApi(DELETEHandler);
