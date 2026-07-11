import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

const SELECT = { salesTaxKind: true, salesTaxPct: true } as const;

/**
 * Config del impuesto de ventas (ERP A3): tipo (none/inc/iva) + tarifa. El
 * impuesto se calcula EMBEBIDO en el precio del menú (no se suma encima) y
 * solo alimenta la contabilidad/reportes.
 */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const settings = await db.restaurant.findUnique({
    where: { id: ctx.restaurantId },
    select: SELECT,
  });
  return NextResponse.json({ settings, country: ctx.country });
}

const patchSchema = z.object({
  salesTaxKind: z.enum(["none", "inc", "iva"]).optional(),
  salesTaxPct: z.number().int().min(0).max(100).optional(),
});

export async function PATCH(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  // "none" ⇒ sin impuesto discriminado: la tarifa queda en 0 por coherencia.
  const data =
    parsed.data.salesTaxKind === "none"
      ? { ...parsed.data, salesTaxPct: 0 }
      : parsed.data;
  const settings = await db.restaurant.update({
    where: { id: ctx.restaurantId },
    data,
    select: SELECT,
  });
  return NextResponse.json({ settings });
}
