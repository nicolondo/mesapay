import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { loadAssetAccountIndex, validateAssetInput } from "@/lib/erp/activos";
import { loadAssetDetail } from "@/lib/erp/activosQuery";
import type { ModuleSlug } from "@/lib/modules";
import { assetPatchSchema } from "../schema";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

type Params = { params: Promise<{ id: string }> };

/**
 * Detalle del activo: cuota mensual, depreciado acumulado (meses cerrados o
 * con asiento), valor en libros, cuotas contabilizadas (con el id del
 * comprobante del mes) y proyección restante.
 */
async function GETHandler(_req: Request, { params }: Params) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const detail = await loadAssetDetail(ctx.restaurantId, id);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(detail);
}

/**
 * Edición de cualquier campo. Los que no vienen se conservan; el conjunto
 * completo se valida como en el alta. OJO: editar valores NO recalcula los
 * meses cerrados (inmutables); las cuotas de los meses abiertos y futuros
 * usan la nueva base cuando el motor regenere el mes.
 */
async function PATCHHandler(req: Request, { params }: Params) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const parsed = assetPatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const current = await db.fixedAsset.findFirst({ where: { id, restaurantId: ctx.restaurantId } });
  if (!current) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const b = parsed.data;
  const v = validateAssetInput(
    {
      name: b.name ?? current.name,
      code: b.code === undefined ? current.code : b.code,
      purchaseDate: b.purchaseDate ?? current.purchaseDate.toISOString().slice(0, 10),
      purchaseCents: b.purchaseCents ?? current.purchaseCents,
      salvageCents: b.salvageCents ?? current.salvageCents,
      usefulLifeMonths: b.usefulLifeMonths ?? current.usefulLifeMonths,
      assetAccountCode: b.assetAccountCode ?? current.assetAccountCode,
      depreciationAccountCode: b.depreciationAccountCode ?? current.depreciationAccountCode,
      expenseAccountCode: b.expenseAccountCode ?? current.expenseAccountCode,
      notes: b.notes === undefined ? current.notes : b.notes,
    },
    await loadAssetAccountIndex(ctx.restaurantId),
  );
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  await db.fixedAsset.update({ where: { id: current.id }, data: v.normalized });
  const detail = await loadAssetDetail(ctx.restaurantId, current.id);
  return NextResponse.json({ ok: true, ...detail });
}

export const GET = secureApi(GETHandler);

export const PATCH = secureApi(PATCHHandler);
