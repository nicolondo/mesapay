import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  conceptErrorStatus,
  deleteRetentionConcept,
  updateRetentionConcept,
} from "@/lib/erp/retenciones";
import { auditConceptChange } from "@/lib/erp/retencionesAudit";
import { MAX_RATE_PPM } from "@/lib/erp/retencionesCore";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

const patchSchema = z.object({
  name: z.string().max(200).optional(),
  ratePpm: z.number().int().min(1).max(MAX_RATE_PPM).optional(),
  thresholdUvt: z.number().int().min(0).max(100_000).optional(),
  accountCode: z.string().max(20).optional(),
  active: z.boolean().optional(),
});

/**
 * Edita un concepto: nombre, tarifa, umbral, cuenta o activo. El tipo no
 * cambia. Los gastos ya registrados conservan su foto (nombre, tarifa y
 * cuenta de ese momento); las sugerencias y las revisiones de impuestos usan
 * la nueva desde ya.
 */
async function PATCHHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    const error =
      field === "ratePpm" ? "rate_invalid" : field === "thresholdUvt" ? "threshold_invalid" : "invalid";
    return NextResponse.json({ error }, { status: 400 });
  }
  const result = await updateRetentionConcept(ctx.restaurantId, id, parsed.data);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: conceptErrorStatus(result.error) });
  }
  await auditConceptChange(ctx.restaurantId, "update", result);
  return NextResponse.json({ concept: result.concept });
}

/**
 * Borra un concepto que nunca se usó. Si ya está en algún gasto, 409
 * «concept_in_use»: se desactiva en vez de borrarse.
 */
async function DELETEHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const result = await deleteRetentionConcept(ctx.restaurantId, id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: conceptErrorStatus(result.error) });
  }
  await auditConceptChange(ctx.restaurantId, "delete", result);
  return NextResponse.json({ ok: true });
}

export const PATCH = secureApi(PATCHHandler);

export const DELETE = secureApi(DELETEHandler);
