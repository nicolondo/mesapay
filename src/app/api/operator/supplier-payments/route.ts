import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { CREDIT_NOTE_GATE, creditErrorResponse } from "@/lib/erp/supplierCreditNoteApi";
import { createSupplierPayment } from "@/lib/erp/supplierPaymentService";
import { loadSupplierPaymentList } from "@/lib/erp/supplierPaymentQueries";

export const dynamic = "force-dynamic";

const id = z.string().min(1).max(40);
const schema = z.object({
  supplierId: id,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  accountCode: z.string().trim().min(4).max(12),
  method: z.string().trim().max(40).nullable().optional(),
  reference: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
  attachmentUrl: z.string().regex(/^\/uploads\/[a-z0-9-]+\.(pdf|jpg|png|webp)$/).nullable().optional(),
  amountCents: z.number().int().min(0).max(2_000_000_000),
  docs: z.array(z.object({ kind: z.enum(["purchase", "expense"]), id })).max(300),
  credits: z.array(z.object({ source: z.enum(["note", "advance"]), id })).max(100).default([]),
  expectedNetCents: z.number().int().nullable().optional(),
});

/** Comprobantes de egreso (`?proveedor&pagina`). */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const sp = new URL(req.url).searchParams;
  const supplierId = sp.get("proveedor");
  const page = Number(sp.get("pagina") ?? "1");
  return NextResponse.json(
    await loadSupplierPaymentList(ctx.restaurantId, {
      supplierId: supplierId && /^[a-z0-9]{10,40}$/i.test(supplierId) ? supplierId : null,
      page: Number.isFinite(page) ? page : 1,
    }),
  );
}

/**
 * «Pagar a proveedor»: cruza los saldos a favor elegidos, aplica el dinero
 * FIFO a las facturas elegidas (en su orden) y deja el excedente como
 * anticipo. Devuelve el comprobante (CE).
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  try {
    const r = await createSupplierPayment(ctx.restaurantId, parsed.data, ctx.userId ?? null, { allowAdvance: true });
    return NextResponse.json({ id: r.id, number: r.number, totals: r.plan.totals }, { status: 201 });
  } catch (err) {
    return creditErrorResponse(err);
  }
}

export const GET = secureApi(GETHandler);
export const POST = secureApi(POSTHandler);
