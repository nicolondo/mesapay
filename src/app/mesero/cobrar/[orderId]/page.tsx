import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { PayFlow } from "@/app/t/[slug]/pay/[orderId]/PayFlow";
import { meseroNeedsShiftToCharge } from "@/lib/meseroShift";
import { MeseroNeedsShift } from "./MeseroNeedsShift";

export const dynamic = "force-dynamic";

/**
 * "Cobrar la cuenta" inline para el mesero — vive bajo /mesero/ para
 * mantenerse dentro del scope del PWA instalado. Hace exactamente
 * lo que /t/[slug]/pay/[orderId]?op=1 pero sin sacar al usuario de la
 * app: el PWA scope `/mesero/` bloquea navegación hacia /t/* (los
 * abriría en Safari aparte, o en standalone el tap simplemente no
 * hace nada). Mismo patrón que /mesero/pedir/[tableId].
 *
 * Los flujos de cobro del mesero (efectivo, tarjeta, datáfono sin
 * device) ya vuelven a /mesero/mesas|salon vía staffHomeHref/Serve,
 * así que el ciclo completo se queda dentro de la PWA.
 *
 * Resolvemos el slug del tenant desde la orden — el botón solo tiene
 * el orderId a mano. Si el mesero no pertenece a ese restaurante
 * devolvemos 404 para no leakear existencia.
 */
export default async function MeseroCobrarPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect(`/signin?callbackUrl=/mesero/cobrar/${orderId}`);
  }
  const role = session.user.role;
  if (role !== "mesero" && role !== "operator" && role !== "platform_admin") {
    redirect("/");
  }

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { restaurantId: true, restaurant: { select: { slug: true } } },
  });
  if (!order) return notFound();

  // Tenant scope — un mesero de otro restaurante no debe cobrar acá.
  // Operator/admin con impersonación ya traen su restaurantId en sesión.
  if (
    role === "mesero" &&
    session.user.restaurantId &&
    session.user.restaurantId !== order.restaurantId
  ) {
    return notFound();
  }

  // En by_waiter, el mesero no puede cobrar sin turno abierto (descuadra
  // su arqueo). Le mostramos un bloqueo con opción de abrir el turno.
  if (
    await meseroNeedsShiftToCharge(
      session.user.id,
      role,
      order.restaurantId,
    )
  ) {
    return <MeseroNeedsShift />;
  }

  return <PayFlow slug={order.restaurant.slug} orderId={orderId} op="1" />;
}
