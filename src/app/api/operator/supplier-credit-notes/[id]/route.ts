import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { CREDIT_NOTE_GATE } from "@/lib/erp/supplierCreditNoteApi";
import { loadCreditNoteDetail } from "@/lib/erp/supplierCreditNoteQueries";

export const dynamic = "force-dynamic";

/** Detalle: líneas, facturas relacionadas, cruces, reintegros y saldo a favor. */
async function GETHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { id } = await params;
  const note = await loadCreditNoteDetail(ctx.restaurantId, id);
  if (!note) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ note });
}

export const GET = secureApi(GETHandler);
