import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { getAccountingConfig } from "@/lib/erp/cierre";
import {
  computeRetentions,
  conceptErrorStatus,
  loadRetentionAccounts,
  loadRetentionConcepts,
  loadRetentionConceptsWithUsage,
  updateRetentionConcept,
} from "@/lib/erp/retenciones";
import { auditConceptChange } from "@/lib/erp/retencionesAudit";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Conceptos de retención del comercio (con cuántos gastos usa cada uno: uno
 * usado no se borra), valor UVT vigente y las cuentas que puede llevar un
 * concepto (2365xx / 2367xx / 2368xx imputables del plan).
 */
async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const [concepts, cfg, accounts] = await Promise.all([
    loadRetentionConceptsWithUsage(ctx.restaurantId),
    getAccountingConfig(ctx.restaurantId),
    loadRetentionAccounts(ctx.restaurantId),
  ]);
  return NextResponse.json({ concepts, uvtCents: cfg.uvtCents, accounts });
}

/** Respuesta tras un cambio: la lista (con uso) y la UVT, como el GET. */
async function listResponse(restaurantId: string) {
  const [concepts, cfg] = await Promise.all([
    loadRetentionConceptsWithUsage(restaurantId),
    getAccountingConfig(restaurantId),
  ]);
  return NextResponse.json({ ok: true, concepts, uvtCents: cfg.uvtCents });
}

const patchSchema = z.object({
  // Actualiza un concepto (activo/tarifa/umbral/nombre) o el valor UVT del
  // comercio. La edición completa vive en /retenciones/conceptos/[id]; esto
  // sigue sirviendo al botón Activo/Inactivo y a la UVT.
  conceptId: z.string().optional(),
  active: z.boolean().optional(),
  /** Tarifa en bps enteros (versión anterior de la pantalla). */
  rateBps: z.number().int().min(1).max(10_000).optional(),
  ratePpm: z.number().int().min(1).max(1_000_000).optional(),
  thresholdUvt: z.number().int().min(0).max(100_000).optional(),
  name: z.string().min(2).max(120).optional(),
  uvtCents: z.number().int().min(100_000).max(100_000_000).optional(),
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
  const b = parsed.data;

  if (b.uvtCents != null) {
    await getAccountingConfig(ctx.restaurantId); // asegura la fila
    await db.accountingConfig.update({
      where: { restaurantId: ctx.restaurantId },
      data: { uvtCents: b.uvtCents },
    });
  }

  if (b.conceptId) {
    const ratePpm = b.ratePpm ?? (b.rateBps != null ? b.rateBps * 100 : undefined);
    const result = await updateRetentionConcept(ctx.restaurantId, b.conceptId, {
      ...(b.active != null && { active: b.active }),
      ...(ratePpm != null && { ratePpm }),
      ...(b.thresholdUvt != null && { thresholdUvt: b.thresholdUvt }),
      ...(b.name != null && { name: b.name }),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: conceptErrorStatus(result.error) });
    }
    await auditConceptChange(ctx.restaurantId, "update", result);
  }

  return listResponse(ctx.restaurantId);
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
async function POSTHandler(req: Request) {
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

export const GET = secureApi(GETHandler);

export const PATCH = secureApi(PATCHHandler);

export const POST = secureApi(POSTHandler);
