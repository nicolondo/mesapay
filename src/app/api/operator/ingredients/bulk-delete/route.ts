import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { previewIngredientDeletion, runIngredientDeletion } from "@/lib/erp/ingredientDeletion";
import { BULK_DELETE_MAX_IDS } from "@/lib/erp/ingredientDeletionText";
import type { ModuleSlug } from "@/lib/modules";
import { secureApi } from "@/lib/secureApi";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["inventory", "purchasing", "recipes"];

const bodySchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(BULK_DELETE_MAX_IDS),
  // true = solo decir qué pasaría (para la confirmación); no borra nada.
  dryRun: z.boolean().optional(),
}).strict();

/**
 * Eliminación masiva desde la selección de Insumos: elimina los que la
 * regla permite y devuelve cuáles NO se pudieron, con sus motivos. Los que
 * no se eliminan quedan intactos (ni siquiera se archivan).
 *
 * Con `dryRun` no elimina: devuelve `deletable` (los que se irían) en vez
 * de `deleted`, para que la pantalla lo diga antes de confirmar.
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  if (parsed.data.dryRun) {
    const preview = await previewIngredientDeletion(db, ctx.restaurantId, parsed.data.ids);
    if (preview.deletable.length === 0 && preview.skipped.length === 0) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(preview);
  }

  const result = await runIngredientDeletion(ctx.restaurantId, parsed.data.ids);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: 409 });
  if (result.deleted.length === 0 && result.skipped.length === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({
    deleted: result.deleted.map((row) => ({ id: row.id, name: row.name })),
    skipped: result.skipped,
    missing: result.missing,
  });
}

export const POST = secureApi(POSTHandler);
