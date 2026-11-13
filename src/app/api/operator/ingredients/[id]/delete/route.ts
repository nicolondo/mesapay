import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { ingredientDeletionCheck, runIngredientDeletion } from "@/lib/erp/ingredientDeletion";
import type { ModuleSlug } from "@/lib/modules";
import { secureApi } from "@/lib/secureApi";

export const dynamic = "force-dynamic";

// El mismo gate que crear, editar y archivar insumos (los roles del
// personal —mesero, cocina, bar— nunca pasan `getErpContext`).
const GATE: ModuleSlug[] = ["inventory", "purchasing", "recipes"];

/**
 * ¿Se puede eliminar del todo este insumo? Devuelve la regla de
 * `@/lib/erp/ingredientDeletion`: `{ deletable: true, removes }` o
 * `{ deletable: false, reasons }` con cuántos y cuáles.
 */
async function GETHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { id } = await params;
  const check = await ingredientDeletionCheck(db, ctx.restaurantId, id);
  if (!check) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(check);
}

/**
 * Elimina el insumo DE VERDAD (el `DELETE /ingredients/[id]` de siempre
 * solo archiva). Solo si nada lo referencia: la regla se vuelve a revisar
 * dentro de la transacción, con el candado de inventario. Si no se puede,
 * 409 `not_deletable` con los motivos.
 */
async function DELETEHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { id } = await params;
  const result = await runIngredientDeletion(ctx.restaurantId, [id]);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 409 });
  const deleted = result.deleted[0];
  if (deleted) return NextResponse.json({ ok: true, deleted: { id: deleted.id, name: deleted.name } });
  const skipped = result.skipped[0];
  if (skipped) return NextResponse.json({ error: "not_deletable", reasons: skipped.reasons }, { status: 409 });
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export const GET = secureApi(GETHandler);

export const DELETE = secureApi(DELETEHandler);
