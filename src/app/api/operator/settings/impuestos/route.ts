import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

/**
 * Impuesto de ventas del comercio (Restaurant.salesTaxKind / salesTaxPct):
 * tipo (none / inc / iva) + tarifa. Va EMBEBIDO en el precio de la carta y
 * viaja en cada factura: es el dato que decide si lo que sale a la DIAN
 * lleva impoconsumo, IVA o nada.
 *
 * SIN gate de módulo, a propósito. Vivía en /accounting/tax-config detrás
 * del módulo `accounting`, y eso dejaba a un comercio sin contabilidad sin
 * forma de configurar el impuesto con el que factura — que necesita tenga
 * o no contabilidad. Es un dato fiscal del comercio, no una función del
 * módulo; mismo criterio que el GET de /api/operator/dian para la
 * resolución de numeración. El guard de rol (operator / platform_admin /
 * group_admin) y el restaurante activo siguen vivos en getErpContext.
 */
const GATE: ModuleSlug[] = [];

const SELECT = { salesTaxKind: true, salesTaxPct: true } as const;

async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const settings = await db.restaurant.findUnique({
    where: { id: ctx.restaurantId },
    select: SELECT,
  });
  return NextResponse.json({ settings, country: ctx.country });
}

const patchSchema = z.object({
  salesTaxKind: z.enum(["none", "inc", "iva"]).optional(),
  salesTaxPct: z.number().int().min(0).max(100).optional(),
});

async function PATCHHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  // "none" ⇒ sin impuesto discriminado: la tarifa queda en 0 por coherencia.
  const data =
    parsed.data.salesTaxKind === "none"
      ? { ...parsed.data, salesTaxPct: 0 }
      : parsed.data;
  const settings = await db.restaurant.update({
    where: { id: ctx.restaurantId },
    data,
    select: SELECT,
  });
  return NextResponse.json({ settings });
}

export const GET = secureApi(GETHandler);

export const PATCH = secureApi(PATCHHandler);
