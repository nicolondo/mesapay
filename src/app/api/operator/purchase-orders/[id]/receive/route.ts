import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  receivePurchaseOrder,
  PurchasingError,
} from "@/lib/erp/purchasing";
import { StockError } from "@/lib/erp/stock";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

const schema = z.object({
  lines: z
    .array(
      z.object({
        itemId: z.string().min(1),
        qtyBase: z.number().int().min(1).max(2_000_000_000),
        costCents: z.number().int().min(0).max(2_000_000_000),
      }),
    )
    .min(1)
    .max(200),
});

/** POST /api/operator/purchase-orders/[id]/receive — recepción total o
 *  parcial. Genera purchase_in en el libro, actualiza costos y precios del
 *  proveedor, y recalcula el estado (spec D3/D4). */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const session = await auth();
  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  // Ajuste del comercio: ¿inventario al neto (IVA descontable) o al bruto?
  const rest = await db.restaurant.findUnique({
    where: { id: ctx.restaurantId },
    select: { purchaseIvaDeductible: true },
  });

  try {
    const result = await db.$transaction(
      (tx) =>
        receivePurchaseOrder(tx, {
          restaurantId: ctx.restaurantId,
          purchaseOrderId: id,
          lines: parsed.data.lines,
          ivaDeductible: rest?.purchaseIvaDeductible ?? false,
          createdById: session?.user?.id ?? null,
        }),
      // Recepciones grandes (muchas líneas) — margen holgado.
      { timeout: 30_000 },
    );
    return NextResponse.json({
      ok: true,
      order: result.purchaseOrder,
      complete: result.complete,
    });
  } catch (err) {
    if (err instanceof PurchasingError) {
      const status =
        err.code === "po_not_found"
          ? 404
          : err.code === "wrong_status"
            ? 409
            : 400;
      return NextResponse.json({ error: err.code }, { status });
    }
    if (err instanceof StockError) {
      return NextResponse.json({ error: err.code }, { status: 400 });
    }
    throw err;
  }
}
