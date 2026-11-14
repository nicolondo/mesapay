import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { getAccountingConfig } from "@/lib/erp/cierre";
import { uvtDelAno } from "@/lib/erp/exogena/normativa";
import { loadRetentionConcepts } from "@/lib/erp/retenciones";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

/** Año en curso en Colombia (las retenciones de compras son colombianas). */
function bogotaYear(now = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric" }).format(now));
}

/**
 * Lo que «Nueva orden» y «Recibir mercancía» necesitan para sugerir las
 * retenciones de la factura en vivo, con el mismo motor puro que el resto
 * del ERP (purchaseRetentions.ts → computeRetentions): los conceptos de
 * retención ACTIVOS del comercio (los activa el contador en Contabilidad ›
 * Impuestos) y la UVT del año (la tabla oficial; si el año no está, la que
 * mantiene el contador). Con el gate de Compras: un comercio sin el módulo
 * de contabilidad igual puede escribir sus retenciones a mano.
 */
async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const [concepts, cfg] = await Promise.all([
    loadRetentionConcepts(ctx.restaurantId),
    getAccountingConfig(ctx.restaurantId),
  ]);
  return NextResponse.json({
    concepts: concepts
      .filter((c) => c.active)
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        name: c.name,
        rateBps: c.rateBps,
        base: c.base,
        thresholdUvt: c.thresholdUvt,
        accountCode: c.accountCode,
        catalogKey: c.catalogKey,
      })),
    uvtCents: uvtDelAno(bogotaYear(), Math.round(cfg.uvtCents / 100)) * 100,
  });
}

export const GET = secureApi(GETHandler);
