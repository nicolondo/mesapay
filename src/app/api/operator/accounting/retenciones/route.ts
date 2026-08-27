import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { getAccountingConfig } from "@/lib/erp/cierre";
import {
  computeRetentions,
  loadRetentionConcepts,
} from "@/lib/erp/retenciones";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** Conceptos de retención del comercio + valor UVT vigente. */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const [concepts, cfg] = await Promise.all([
    loadRetentionConcepts(ctx.restaurantId),
    getAccountingConfig(ctx.restaurantId),
  ]);
  return NextResponse.json({ concepts, uvtCents: cfg.uvtCents });
}

const patchSchema = z.object({
  // Actualiza un concepto (toggle/tarifa/umbral) o el valor UVT del comercio.
  conceptId: z.string().optional(),
  active: z.boolean().optional(),
  rateBps: z.number().int().min(0).max(10_000).optional(),
  thresholdUvt: z.number().int().min(0).max(100_000).optional(),
  name: z.string().min(2).max(120).optional(),
  uvtCents: z.number().int().min(100_000).max(100_000_000).optional(),
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
  const b = parsed.data;

  if (b.uvtCents != null) {
    await getAccountingConfig(ctx.restaurantId); // asegura la fila
    await db.accountingConfig.update({
      where: { restaurantId: ctx.restaurantId },
      data: { uvtCents: b.uvtCents },
    });
  }

  if (b.conceptId) {
    const concept = await db.retentionConcept.findFirst({
      where: { id: b.conceptId, restaurantId: ctx.restaurantId },
      select: { id: true },
    });
    if (!concept) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    await db.retentionConcept.update({
      where: { id: concept.id },
      data: {
        ...(b.active != null && { active: b.active }),
        ...(b.rateBps != null && { rateBps: b.rateBps }),
        ...(b.thresholdUvt != null && { thresholdUvt: b.thresholdUvt }),
        ...(b.name != null && { name: b.name }),
      },
    });
  }

  const [concepts, cfg] = await Promise.all([
    loadRetentionConcepts(ctx.restaurantId),
    getAccountingConfig(ctx.restaurantId),
  ]);
  return NextResponse.json({ ok: true, concepts, uvtCents: cfg.uvtCents });
}

const previewSchema = z.object({
  subtotalCents: z.number().int().min(0),
  taxCents: z.number().int().min(0).default(0),
});

/**
 * Sugerencia de retenciones para un documento de compra: aplica los
 * conceptos ACTIVOS con los umbrales UVT. La usa el formulario de compras
 * para prellenar retefuente/reteIVA/reteICA (el operador puede ajustar).
 */
export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const body = await req.json().catch(() => null);
  const parsed = previewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const [concepts, cfg] = await Promise.all([
    loadRetentionConcepts(ctx.restaurantId),
    getAccountingConfig(ctx.restaurantId),
  ]);
  const result = computeRetentions(
    concepts.filter((c) => c.active),
    {
      subtotalCents: parsed.data.subtotalCents,
      taxCents: parsed.data.taxCents,
    },
    cfg.uvtCents,
  );
  return NextResponse.json(result);
}
