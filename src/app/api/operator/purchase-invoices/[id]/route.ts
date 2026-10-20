import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { PurchaseInvoiceSchema } from "@/lib/anthropic";
import { matchInvoice } from "@/lib/erp/invoiceMatch";
import { loadInvoiceMatchContext } from "@/lib/erp/invoiceMatchContext";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

/** Re-abre una carga (para editar la extracción sin re-subir). */
async function GETHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const upload = await db.purchaseInvoiceUpload.findUnique({
    where: { id },
    select: {
      id: true,
      restaurantId: true,
      fileUrl: true,
      status: true,
      extraction: true,
      purchaseOrderId: true,
    },
  });
  if (!upload || upload.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const selectedSupplierId = new URL(req.url).searchParams.get("supplierId") ?? undefined;
  if (selectedSupplierId !== undefined) {
    const supplier = await db.supplier.findFirst({
      where: { id: selectedSupplierId, restaurantId: ctx.restaurantId, active: true },
      select: { id: true },
    });
    if (!supplier) return NextResponse.json({ error: "supplier_not_found" }, { status: 404 });
  }
  const parsed = PurchaseInvoiceSchema.safeParse(upload.extraction);
  if (upload.status !== "pending" || !parsed.success) {
    return NextResponse.json({ upload, match: null });
  }
  // The extraction was normalized before persistence. Do not drop/reorder its
  // lines here: their indices are the source references submitted at confirm.
  const matchCtx = await loadInvoiceMatchContext(ctx.restaurantId, parsed.data.lines.map((line) => line.description));
  const match = matchInvoice(parsed.data, matchCtx, selectedSupplierId);
  return NextResponse.json({ upload, match });
}

/** Descartar una carga (no borra la imagen — evidencia). */
async function DELETEHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const upload = await db.purchaseInvoiceUpload.findUnique({
    where: { id },
    select: { id: true, restaurantId: true, status: true },
  });
  if (!upload || upload.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (upload.status === "confirmed") {
    return NextResponse.json({ error: "already_confirmed" }, { status: 409 });
  }
  const discarded = await db.purchaseInvoiceUpload.updateMany({
    where: { id, restaurantId: ctx.restaurantId, status: "pending" },
    data: { status: "discarded" },
  });
  if (discarded.count !== 1 && upload.status !== "discarded") {
    return NextResponse.json({ error: "already_confirmed" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}

export const GET = secureApi(GETHandler);

export const DELETE = secureApi(DELETEHandler);
