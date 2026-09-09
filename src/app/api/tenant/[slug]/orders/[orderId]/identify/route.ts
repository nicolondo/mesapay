import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { publishOrderEvent } from "@/lib/events";
import { requireTenantDiner } from "@/lib/dinerTenant";
import { applyDinerToOrder } from "@/lib/dinerDiscount";

/**
 * POST /api/tenant/[slug]/orders/[orderId]/identify — el comensal se
 * identifica a sí mismo en la cuenta de la mesa.
 *
 * No recibe ningún id por el cuerpo: la identidad sale de SU sesión en ESTE
 * comercio. Si aceptáramos un id del cliente, cualquiera podría atribuirse
 * la cuenta de otro (y su descuento).
 */
async function POSTHandler(
  _req: Request,
  { params }: { params: Promise<{ slug: string; orderId: string }> },
) {
  const { slug, orderId } = await params;

  const ctx = await requireTenantDiner(slug);
  if (!ctx) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = await applyDinerToOrder({
    orderId,
    restaurantId: ctx.restaurantId,
    dinerId: ctx.diner.id,
  });
  if (!result) {
    return NextResponse.json({ error: "not_applicable" }, { status: 409 });
  }

  publishOrderEvent(ctx.restaurantId, { type: "order.updated", orderId });

  return NextResponse.json({
    ok: true,
    name: result.name,
    discountPct: result.discountPct,
    discountCents: result.discountCents,
  });
}

export const POST = secureApi(POSTHandler);
