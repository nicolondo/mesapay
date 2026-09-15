import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

/**
 * Configuración de bonos del comercio: modo de cobro (prepago / crédito),
 * valor y vigencia por defecto. El modo se COPIA a cada lote al emitirlo
 * — cambiarlo acá no toca los lotes que ya existen.
 */
const GATE: ModuleSlug[] = ["vouchers"];

const SELECT = { mode: true, defaultValueCents: true, defaultExpiryDays: true } as const;

const DEFAULTS = { mode: "prepaid" as const, defaultValueCents: 0, defaultExpiryDays: null };

async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const settings = await db.voucherSettings.findUnique({
    where: { restaurantId: ctx.restaurantId },
    select: SELECT,
  });
  return NextResponse.json({ settings: settings ?? DEFAULTS });
}

const patchSchema = z.object({
  mode: z.enum(["prepaid", "credit"]).optional(),
  defaultValueCents: z.number().int().min(0).max(100_000_000_00).optional(),
  defaultExpiryDays: z.number().int().min(1).max(3650).nullable().optional(),
});

async function PATCHHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const settings = await db.voucherSettings.upsert({
    where: { restaurantId: ctx.restaurantId },
    create: { restaurantId: ctx.restaurantId, ...DEFAULTS, ...parsed.data },
    update: parsed.data,
    select: SELECT,
  });
  return NextResponse.json({ settings });
}

export const GET = secureApi(GETHandler);
export const PATCH = secureApi(PATCHHandler);
