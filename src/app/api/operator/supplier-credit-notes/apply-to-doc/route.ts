import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { applySupplierCreditToDoc } from "@/lib/erp/supplierPaymentService";
import { CREDIT_NOTE_GATE, creditErrorResponse } from "@/lib/erp/supplierCreditNoteApi";

export const dynamic = "force-dynamic";

const schema = z.object({
  kind: z.enum(["purchase", "expense"]),
  id: z.string().min(1).max(40),
  amountCents: z.number().int().min(1).max(2_000_000_000).nullable().optional(),
});

/**
 * Uso del saldo a favor del proveedor en UNA factura (compra recibida o
 * gasto): consume sus notas de la más vieja a la más nueva.
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  try {
    const r = await applySupplierCreditToDoc(ctx.restaurantId, parsed.data, ctx.userId ?? null);
    return NextResponse.json(r);
  } catch (err) {
    return creditErrorResponse(err);
  }
}

export const POST = secureApi(POSTHandler);
