import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { conceptErrorStatus, createRetentionConcept } from "@/lib/erp/retenciones";
import { auditConceptChange } from "@/lib/erp/retencionesAudit";
import { MAX_RATE_PPM, RETENTION_KINDS } from "@/lib/erp/retencionesCore";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

const createSchema = z.object({
  kind: z.enum(RETENTION_KINDS),
  name: z.string().max(200),
  /** Tarifa exacta en partes por millón: 1 % = 10.000; 4,14 ‰ = 4.140. */
  ratePpm: z.number().int().min(1).max(MAX_RATE_PPM),
  thresholdUvt: z.number().int().min(0).max(100_000),
  accountCode: z.string().max(20),
  active: z.boolean().default(true),
  /** Del catálogo (`retencionesCatalogo.ts`); null o ausente = personalizado. */
  catalogKey: z.string().max(60).nullish(),
});

/**
 * Crea un concepto de retención: desde el catálogo (con su clave) o
 * personalizado. Nombre único por comercio y tipo, tarifa > 0 y ≤ 100 %,
 * cuenta imputable del plan bajo 2365 / 2367 / 2368 según el tipo. Queda
 * en la auditoría. Activo por defecto: aparece de una vez en las
 * sugerencias de compras y gastos.
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    const error =
      field === "ratePpm"
        ? "rate_invalid"
        : field === "thresholdUvt"
          ? "threshold_invalid"
          : field === "name"
            ? "name_invalid"
            : field === "kind"
              ? "kind_invalid"
              : "invalid";
    return NextResponse.json({ error }, { status: 400 });
  }
  const b = parsed.data;
  const result = await createRetentionConcept(ctx.restaurantId, {
    kind: b.kind,
    name: b.name,
    ratePpm: b.ratePpm,
    thresholdUvt: b.thresholdUvt,
    accountCode: b.accountCode,
    active: b.active,
    catalogKey: b.catalogKey ?? null,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: conceptErrorStatus(result.error) });
  }
  await auditConceptChange(ctx.restaurantId, "create", result);
  return NextResponse.json({ concept: { ...result.concept, usedCount: 0 } }, { status: 201 });
}

export const POST = secureApi(POSTHandler);
