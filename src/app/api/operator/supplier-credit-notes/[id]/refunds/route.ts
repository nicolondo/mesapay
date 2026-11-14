import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { createCreditRefund } from "@/lib/erp/supplierCreditNoteService";
import { CREDIT_NOTE_GATE, creditErrorResponse, refundSchema } from "@/lib/erp/supplierCreditNoteApi";

export const dynamic = "force-dynamic";

/** El proveedor devolvió en dinero el saldo a favor: entra a caja/banco. */
async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const parsed = refundSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { id } = await params;
  try {
    const r = await createCreditRefund(ctx.restaurantId, id, parsed.data, ctx.userId ?? null);
    return NextResponse.json({ id: r.id }, { status: 201 });
  } catch (err) {
    return creditErrorResponse(err);
  }
}

export const POST = secureApi(POSTHandler);
