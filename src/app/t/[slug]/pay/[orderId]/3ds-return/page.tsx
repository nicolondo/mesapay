import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { ThreeDsReturnClient } from "./ThreeDsReturnClient";

export const dynamic = "force-dynamic";

/**
 * Callback que el banco invoca después del challenge 3DS de la tarjeta.
 * Kushki nos manda acá vía 301 GET con `?success=true&token=...` (o
 * `success=false&message=...` si la auth falló).
 *
 * En este punto el browser hizo navegación completa (no más React
 * state), así que el amount/tip que el diner había configurado en el
 * checkout lo recuperamos de localStorage — el CardSheet lo dejó ahí
 * antes de redirigir al banco.
 *
 * El charge real lo hace el client component vía POST a
 * /api/.../pay/kushki-charge con method=kushki_card. Si aprueba,
 * redirige al diner a /done. Si declina, vuelve al checkout con un
 * banner de "Pago rechazado".
 */
export default async function ThreeDsReturnPage({
  params,
}: {
  params: Promise<{ slug: string; orderId: string }>;
}) {
  const { slug, orderId } = await params;

  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) notFound();

  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order || order.restaurantId !== tenant.id) notFound();

  return (
    <ThreeDsReturnClient tenantSlug={slug} orderId={orderId} />
  );
}
