import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

// Acciones sobre la OC (spec D1/D5). Las líneas de un draft se editan
// re-creando la OC desde la UI (borrar draft + crear) — mantener PATCH de
// líneas fuera simplifica el server sin perder capacidad real.
const patchSchema = z.object({
  action: z.enum(["mark_sent", "cancel", "update_invoice", "mark_paid", "edit"]),
  // edit (solo draft):
  notes: z.string().trim().max(1000).nullable().optional(),
  expectedAt: z.string().datetime().nullable().optional(),
  // update_invoice:
  supplierInvoiceNumber: z.string().trim().max(80).nullable().optional(),
  invoiceDueAt: z.string().datetime().nullable().optional(),
  // mark_paid:
  paymentNote: z.string().trim().max(300).nullable().optional(),
});

async function loadOwned(id: string, restaurantId: string) {
  const po = await db.purchaseOrder.findUnique({
    where: { id },
    select: { id: true, restaurantId: true, status: true },
  });
  if (!po || po.restaurantId !== restaurantId) return null;
  return po;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const order = await db.purchaseOrder.findUnique({
    where: { id },
    include: {
      supplier: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          paymentTermsDays: true,
        },
      },
      createdBy: { select: { id: true, name: true } },
      items: {
        include: {
          ingredient: { select: { id: true, name: true, measureKind: true } },
          supplierItem: {
            select: { id: true, presentationLabel: true, contentQty: true },
          },
        },
      },
      // Recepciones = movimientos del libro ligados a esta OC.
      movements: {
        orderBy: { createdAt: "desc" },
        include: {
          ingredient: { select: { id: true, name: true, measureKind: true } },
          createdBy: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!order || order.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ order });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const po = await loadOwned(id, ctx.restaurantId);
  if (!po) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  const now = new Date();

  switch (b.action) {
    case "edit": {
      if (po.status !== "draft") {
        return NextResponse.json({ error: "wrong_status" }, { status: 409 });
      }
      const order = await db.purchaseOrder.update({
        where: { id },
        data: {
          ...(b.notes !== undefined ? { notes: b.notes } : {}),
          ...(b.expectedAt !== undefined
            ? { expectedAt: b.expectedAt ? new Date(b.expectedAt) : null }
            : {}),
        },
      });
      return NextResponse.json({ order });
    }
    case "mark_sent": {
      if (po.status !== "draft" && po.status !== "sent") {
        return NextResponse.json({ error: "wrong_status" }, { status: 409 });
      }
      const order = await db.purchaseOrder.update({
        where: { id },
        data: { status: "sent", sentAt: now },
      });
      return NextResponse.json({ order });
    }
    case "cancel": {
      // Solo sin recepciones (spec D1). Reclamo condicionado — carrera con
      // una recepción concurrente pierde limpio.
      const claimed = await db.purchaseOrder.updateMany({
        where: { id, status: { in: ["draft", "sent"] } },
        data: { status: "canceled", canceledAt: now },
      });
      if (claimed.count === 0) {
        return NextResponse.json({ error: "wrong_status" }, { status: 409 });
      }
      const order = await db.purchaseOrder.findUnique({ where: { id } });
      return NextResponse.json({ order });
    }
    case "update_invoice": {
      const order = await db.purchaseOrder.update({
        where: { id },
        data: {
          ...(b.supplierInvoiceNumber !== undefined
            ? { supplierInvoiceNumber: b.supplierInvoiceNumber }
            : {}),
          ...(b.invoiceDueAt !== undefined
            ? { invoiceDueAt: b.invoiceDueAt ? new Date(b.invoiceDueAt) : null }
            : {}),
        },
      });
      return NextResponse.json({ order });
    }
    case "mark_paid": {
      if (po.status !== "received" && po.status !== "partially_received") {
        return NextResponse.json({ error: "wrong_status" }, { status: 409 });
      }
      const order = await db.purchaseOrder.update({
        where: { id },
        data: { paidAt: now, paymentNote: b.paymentNote ?? null },
      });
      return NextResponse.json({ order });
    }
  }
}
