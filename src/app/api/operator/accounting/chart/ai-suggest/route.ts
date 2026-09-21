import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { suggestAccountWithAi } from "@/lib/erp/chartAi";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

const bodySchema = z.object({
  description: z.string().trim().min(5).max(300),
  parentCodeHint: z.string().trim().min(1).max(20).optional(),
});

/**
 * "Sugerir con IA": devuelve una cuenta propuesta (madre, código, nombre,
 * tipo heredado, nota y avisos) para prellenar el formulario. No inserta
 * nada. 502 `ai_unavailable` si no hay API key o el modelo falla; 422
 * `ai_invalid` si lo propuesto no pasa las reglas del plan.
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const r = await suggestAccountWithAi({
    restaurantId: ctx.restaurantId,
    description: parsed.data.description,
    parentCodeHint: parsed.data.parentCodeHint ?? null,
    country: ctx.country,
  });
  if (!r.ok) {
    const status =
      r.error === "ai_unavailable" ? 502 : r.error === "ai_invalid" ? 422 : 400;
    return NextResponse.json({ error: r.error, detail: r.detail }, { status });
  }
  return NextResponse.json({ suggestion: r.suggestion, warnings: r.warnings });
}

export const POST = secureApi(POSTHandler);
