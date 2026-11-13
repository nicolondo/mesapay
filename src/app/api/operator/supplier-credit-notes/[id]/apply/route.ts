import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { applyCreditNote } from "@/lib/erp/supplierCreditNoteService";
import { allocationSchema, CREDIT_NOTE_GATE, creditErrorResponse } from "@/lib/erp/supplierCreditNoteApi";

export const dynamic = "force-dynamic";

const schema = z.object({ applications: allocationSchema.nullable().optional() });

/** Aplica el saldo a favor de la nota a facturas del proveedor (plan elegido o FIFO). */
async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { id } = await params;
  try {
    const r = await applyCreditNote(ctx.restaurantId, id, parsed.data.applications ?? null, ctx.userId ?? null);
    return NextResponse.json(r);
  } catch (err) {
    return creditErrorResponse(err);
  }
}

export const POST = secureApi(POSTHandler);
