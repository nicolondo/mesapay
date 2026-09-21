import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { updateAccount } from "@/lib/erp/chart";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    active: z.boolean().optional(),
  })
  .refine((b) => b.name !== undefined || b.active !== undefined, {
    message: "nothing_to_update",
  });

/**
 * Renombrar o activar/desactivar una cuenta. Nunca borra. 404 si no es
 * del comercio; 400 con el código del error (`has_movements`,
 * `engine_account`, `has_active_children`, `parent_inactive`, `bad_name`).
 */
async function PATCHHandler(
  req: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { code } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const r = await updateAccount(ctx.restaurantId, code, parsed.data);
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error },
      { status: r.error === "not_found" ? 404 : 400 },
    );
  }
  return NextResponse.json({ account: r.account });
}

export const PATCH = secureApi(PATCHHandler);
