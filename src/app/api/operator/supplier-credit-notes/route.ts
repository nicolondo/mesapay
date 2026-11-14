import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { createSupplierCreditNote } from "@/lib/erp/supplierCreditNoteService";
import { CREDIT_NOTE_GATE, createCreditNoteSchema, creditErrorResponse } from "@/lib/erp/supplierCreditNoteApi";
import { parseCreditNoteListParams } from "@/lib/erp/supplierCreditNoteList";
import { loadCreditNoteListPage } from "@/lib/erp/supplierCreditNoteQueries";

export const dynamic = "force-dynamic";

/** Lista filtrada (mismos parámetros que la URL de la pantalla) con su resumen. */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const sp = Object.fromEntries(new URL(req.url).searchParams.entries());
  const list = await loadCreditNoteListPage(ctx.restaurantId, parseCreditNoteListParams(sp));
  return NextResponse.json(list);
}

/**
 * Registra una nota crédito del proveedor y la aplica de una vez a las
 * facturas (las que relaciona primero, luego FIFO; o el plan que eligió el
 * operador). Lo que no se cruza queda como saldo a favor del proveedor.
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const parsed = createCreditNoteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  try {
    const note = await createSupplierCreditNote(
      ctx.restaurantId,
      { ...parsed.data, applications: parsed.data.applications ?? null },
      ctx.userId ?? null,
    );
    return NextResponse.json({ id: note.id }, { status: 201 });
  } catch (err) {
    return creditErrorResponse(err);
  }
}

export const GET = secureApi(GETHandler);
export const POST = secureApi(POSTHandler);
