import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { getAccountingConfig } from "@/lib/erp/cierre";
import { purchaseTaxRates } from "@/lib/erp/purchaseTax";
import { loadRetentionConcepts } from "@/lib/erp/retenciones";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Lo que el formulario de gastos necesita para calcular en vivo, con el
 * MISMO motor puro que usa el servidor al guardar (expenseTax.ts): los
 * conceptos de retención del comercio (activos e inactivos: un gasto viejo
 * puede tener uno que ya se desactivó), la UVT que mantiene el contador,
 * si el comercio descuenta el IVA de compras y las tarifas de IVA del país.
 */
async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const [concepts, cfg, tenant] = await Promise.all([
    loadRetentionConcepts(ctx.restaurantId),
    getAccountingConfig(ctx.restaurantId),
    db.restaurant.findUnique({
      where: { id: ctx.restaurantId },
      select: { purchaseIvaDeductible: true },
    }),
  ]);
  return NextResponse.json({
    concepts: concepts.map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      rateBps: c.rateBps,
      base: c.base,
      thresholdUvt: c.thresholdUvt,
      accountCode: c.accountCode,
      active: c.active,
    })),
    uvtCents: cfg.uvtCents,
    ivaDeductible: tenant?.purchaseIvaDeductible ?? false,
    ivaRates: purchaseTaxRates(ctx.country),
  });
}

export const GET = secureApi(GETHandler);
