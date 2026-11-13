import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { PayFlow } from "@/app/t/[slug]/pay/[orderId]/PayFlow";
import { staffForRestaurant } from "@/lib/staffAccess";

export const dynamic = "force-dynamic";

/** Roles del área del datáfono (los mismos que deja entrar su layout). */
const TERMINAL_AREA_ROLES = ["terminal", "operator", "platform_admin"] as const;

/**
 * «Cobrar» del usuario de DATÁFONO, desde la ficha de una mesa en «Mesas en
 * vivo». Es el MISMO checkout que usan el mesero (/mesero/cobrar) y el
 * administrador (/t/[slug]/pay/[orderId]?op=1): `PayFlow` en modo staff, con
 * total o parcial, dividir, propina, datáfono (eligiendo el equipo si hay
 * varios), datáfono propio del comercio, efectivo y la factura. Acá no se
 * calcula nada de plata.
 *
 * Qué NO le ofrece al datáfono (cortesías, anular facturas, crédito, bonos,
 * cliente, factura antes de cobrar) lo decide `staffCheckoutCapabilities`
 * en PayFlow, y cada ruta del servidor lo bloquea igual.
 *
 * "Solo el administrador cobra" (`adminOnlyCharge`) no aplica al datáfono:
 * la opción apunta a los meseros (ver src/lib/chargeControl.ts). Tampoco
 * pide turno: el efectivo que cobra va a la caja del local, como el del
 * administrador.
 *
 * Resolvemos el comercio desde la orden. Si quien entra no es del equipo de
 * ese comercio, 404 (no confirmamos que la cuenta exista).
 */
export default async function TerminalCobrarPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ declined?: string }>;
}) {
  const { orderId } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect(`/signin?callbackUrl=/terminal/cobrar/${orderId}`);
  }
  const role = session.user.role;
  if (!(TERMINAL_AREA_ROLES as readonly string[]).includes(role)) {
    redirect("/");
  }

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: { restaurantId: true, restaurant: { select: { slug: true } } },
  });
  if (!order) return notFound();
  if (!(await staffForRestaurant(order.restaurantId, [...TERMINAL_AREA_ROLES]))) {
    return notFound();
  }

  const { declined } = await searchParams;
  // El área del datáfono es oscura; el checkout va sobre su fondo claro de
  // siempre (el mismo del mesero y del comensal).
  return (
    <div className="flex flex-1 flex-col min-h-full bg-bone text-ink">
      <PayFlow slug={order.restaurant.slug} orderId={orderId} op="1" declined={declined} />
    </div>
  );
}
