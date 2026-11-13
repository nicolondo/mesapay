import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { CREDIT_NOTE_GATE, creditErrorResponse } from "@/lib/erp/supplierCreditNoteApi";
import { voidSupplierPayment } from "@/lib/erp/supplierPaymentService";

export const dynamic = "force-dynamic";

const schema = z.object({ reason: z.string().trim().max(300).nullable().optional() });

/** Anula el comprobante (no lo borra): deshace sus abonos y cruces; el motor asienta el reverso. */
async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { id } = await params;
  try {
    await voidSupplierPayment(ctx.restaurantId, id, parsed.data.reason ?? null, ctx.userId ?? null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return creditErrorResponse(err);
  }
}

export const POST = secureApi(POSTHandler);
