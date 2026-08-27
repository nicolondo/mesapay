import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  accumulatedThrough,
  depreciationForAssetMonth,
} from "@/lib/erp/activos";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** Cuentas del activo permitidas en el alta (PPE del PUC sembrado). */
const ASSET_ACCOUNTS = new Set([
  "151605", // mejoras a propiedad ajena
  "152005", // equipo de cocina
  "152405", // muebles y enseres
  "152805", // cómputo y POS
  "154005", // vehículos
]);

/** Activos del comercio con su estado de depreciación al mes actual. */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const assets = await db.fixedAsset.findMany({
    where: { restaurantId: ctx.restaurantId },
    orderBy: [{ active: "desc" }, { purchaseDate: "desc" }],
  });
  const month = new Date().toISOString().slice(0, 7);
  return NextResponse.json({
    assets: assets.map((a) => ({
      id: a.id,
      name: a.name,
      purchaseDate: a.purchaseDate.toISOString().slice(0, 10),
      purchaseCents: a.purchaseCents,
      salvageCents: a.salvageCents,
      usefulLifeMonths: a.usefulLifeMonths,
      assetAccountCode: a.assetAccountCode,
      active: a.active,
      monthlyCents: depreciationForAssetMonth(a, month),
      accumulatedCents: accumulatedThrough(a, month),
    })),
  });
}

const createSchema = z.object({
  name: z.string().min(2).max(160),
  purchaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  purchaseCents: z.number().int().min(100).max(50_000_000_000),
  salvageCents: z.number().int().min(0).default(0),
  usefulLifeMonths: z.number().int().min(1).max(600),
  assetAccountCode: z.string().default("152405"),
});

export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  if (!ASSET_ACCOUNTS.has(b.assetAccountCode)) {
    return NextResponse.json({ error: "account_not_allowed" }, { status: 400 });
  }
  if (b.salvageCents >= b.purchaseCents) {
    return NextResponse.json({ error: "salvage_too_high" }, { status: 400 });
  }
  const asset = await db.fixedAsset.create({
    data: {
      restaurantId: ctx.restaurantId,
      name: b.name,
      purchaseDate: new Date(`${b.purchaseDate}T00:00:00Z`),
      purchaseCents: b.purchaseCents,
      salvageCents: b.salvageCents,
      usefulLifeMonths: b.usefulLifeMonths,
      assetAccountCode: b.assetAccountCode,
    },
    select: { id: true },
  });
  return NextResponse.json({ ok: true, id: asset.id });
}

const patchSchema = z.object({
  assetId: z.string(),
  // Baja del activo: deja de depreciar desde el mes de la baja.
  action: z.enum(["dispose", "reactivate"]),
});

export async function PATCH(req: Request) {
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
