import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { CREDIT_NOTE_GATE } from "@/lib/erp/supplierCreditNoteApi";
import { loadSupplierPaymentDetail } from "@/lib/erp/supplierPaymentQueries";

export const dynamic = "force-dynamic";

async function GETHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { id } = await params;
  const payment = await loadSupplierPaymentDetail(ctx.restaurantId, id);
  if (!payment) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ payment });
}

export const GET = secureApi(GETHandler);
