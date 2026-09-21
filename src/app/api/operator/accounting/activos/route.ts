import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { loadAssetAccountIndex, validateAssetInput } from "@/lib/erp/activos";
import { listAssets, loadAssetFormOptions } from "@/lib/erp/activosQuery";
import type { ModuleSlug } from "@/lib/modules";
import { assetBodySchema } from "./schema";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Activos del comercio con su progreso contabilizado (depreciado, valor en
 * libros, meses contabilizados / vida útil) + cuentas para el formulario
 * (imputables activas 15xx y 5xxx).
 */
async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const [assets, options] = await Promise.all([
    listAssets(ctx.restaurantId),
    loadAssetFormOptions(ctx.restaurantId),
  ]);
  return NextResponse.json({ assets, ...options });
}

/** Alta (sin asiento: el activo ya quedó contabilizado por la compra). 201 / 400 con código. */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = assetBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const v = validateAssetInput(parsed.data, await loadAssetAccountIndex(ctx.restaurantId));
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  const asset = await db.fixedAsset.create({
    data: { restaurantId: ctx.restaurantId, ...v.normalized },
    select: { id: true },
  });
  return NextResponse.json({ ok: true, id: asset.id }, { status: 201 });
}

const patchSchema = z.object({
  assetId: z.string(),
  // Baja: deprecia hasta el mes de la baja inclusive y nada después.
  // Reactivar vuelve a la vida útil completa.
  action: z.enum(["dispose", "reactivate"]),
});

async function PATCHHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const asset = await db.fixedAsset.findFirst({
    where: { id: parsed.data.assetId, restaurantId: ctx.restaurantId },
    select: { id: true },
  });
  if (!asset) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await db.fixedAsset.update({
    where: { id: asset.id },
    data:
      parsed.data.action === "dispose"
        ? { active: false, disposedAt: new Date() }
        : { active: true, disposedAt: null },
  });
  return NextResponse.json({ ok: true });
}

export const GET = secureApi(GETHandler);

export const POST = secureApi(POSTHandler);

export const PATCH = secureApi(PATCHHandler);
