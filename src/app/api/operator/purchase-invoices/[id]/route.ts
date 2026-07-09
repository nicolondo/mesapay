import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

/** Re-abre una carga (para editar la extracción sin re-subir). */
export async function GET(
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
  return NextResponse.json({ upload });
}

/** Descartar una carga (no borra la imagen — evidencia). */
export async function DELETE(
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
  await db.purchaseInvoiceUpload.update({
    where: { id },
    data: { status: "discarded" },
  });
  return NextResponse.json({ ok: true });
}
