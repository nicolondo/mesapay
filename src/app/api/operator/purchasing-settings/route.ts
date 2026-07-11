import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

const SELECT = { purchaseIvaDeductible: true } as const;

/** Ajustes de compras (F5): IVA descontable + país (para las tarifas de IVA). */
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
  purchaseIvaDeductible: z.boolean().optional(),
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
  const settings = await db.restaurant.update({
    where: { id: ctx.restaurantId },
    data: parsed.data,
    select: SELECT,
  });
  return NextResponse.json({ settings });
}
