import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { getViewer } from "@/lib/customerSession";
import { applyCustomerToOrder } from "@/lib/customerDiscount";

/**
 * POST /api/tenant/[slug]/orders/[orderId]/identify — el comensal se
 * identifica a sí mismo en la cuenta de la mesa.
 *
 * No recibe ningún id de usuario por el cuerpo: la identidad sale de SU
 * sesión. Si aceptáramos un userId del cliente, cualquiera podría
 * atribuirse la cuenta de otro (y su descuento).
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ slug: string; orderId: string }> },
) {
  const { slug, orderId } = await params;

  const viewer = await getViewer();
  if (!viewer || viewer.role !== "customer") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!tenant) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  }

  const result = await applyCustomerToOrder({
    orderId,
    restaurantId: tenant.id,
    userId: viewer.id,
  });
  if (!result) {
    return NextResponse.json({ error: "not_applicable" }, { status: 409 });
  }

  publishOrderEvent(tenant.id, { type: "order.updated", orderId });

  return NextResponse.json({
    ok: true,
    name: result.name,
    discountPct: result.discountPct,
    discountCents: result.discountCents,
  });
}
