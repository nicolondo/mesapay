import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { auth } from "@/auth";
import { PayClient } from "./PayClient";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";
import { resolveEnabledPaymentMethods } from "@/lib/paymentMethods";
import { getAssignedDevice } from "@/lib/meseroDevice";

/**
 * Núcleo del flujo de cobro, compartido por dos puntos de entrada:
 *
 *   1. /t/[slug]/pay/[orderId]        — el comensal paga desde su QR.
 *   2. /mesero/cobrar/[orderId]       — el mesero cobra desde su PWA,
 *      dentro del scope /mesero/ para no rebotar a Safari (igual que
 *      /mesero/pedir/[tableId] hace con la carta).
 *
 * `op` lo pasa el caller (el comensal nunca; el mesero siempre "1").
 * Sólo se honra si la sesión es staff real — la URL sola no basta.
 */
export async function PayFlow({
  slug,
  orderId,
  op,
  declined,
}: {
  slug: string;
  orderId: string;
  op?: string;
  declined?: string;
}) {
  // Operator-mode pay flow: el staff está cobrando la cuenta en
  // nombre de un comensal que no tiene celular o pidió verbalmente.
  // Sólo honramos op === "1" si la sesión es staff real — nunca confiar
  // en la URL sola. Incluimos `mesero` porque desde su PWA tiene
  // un botón "Cobrar la cuenta" que apunta acá; sin este rol caía
  // al flow del cliente con "Partes iguales / Lo mío".
  const session = op === "1" ? await auth() : null;
  const operatorMode =
    !!session?.user &&
    (session.user.role === "operator" ||
      session.user.role === "platform_admin" ||
      session.user.role === "mesero");
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) return notFound();

  // Heal stale subtotals before showing payment options — otherwise the
  // diner could end up paying for items that were cancelled in the kitchen.
  await syncOrderSubtotalFromLiveItems(orderId);

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      table: true,
      payments: true,
      // El resumen del cobro (y el OrderItem.guestName aggregator)
      // solo deben ver items vivos — un plato cancelado no aporta a
      // lo que el cliente paga.
      items: { where: { cancelledAt: null }, orderBy: { id: "asc" } },
    },
  });
  if (!order || order.restaurantId !== tenant.id) return notFound();

  const approved = order.payments.filter((p) => p.status === "approved");
  const paidCents = approved.reduce((s, p) => s + p.amountCents, 0);
  const paidTipCents = approved.reduce((s, p) => s + p.tipCents, 0);
  const kushkiReady =
    !!tenant.kushkiMerchantId && tenant.kushkiOnboardingStatus === "active";

  // In operator mode, look up which Smart POS this user is logged into
  // (set by the operator in /operator/settings/datafonos). When set,
  // PayClient skips the Salón bounce and pushes the datáfono charge
  // straight to the assigned device.
  const assignedDevice =
    operatorMode && session?.user?.id
      ? await getAssignedDevice(session.user.id, tenant.id)
      : null;

  // NO pre-fetcheamos los bancos PSE acá. Esa llamada a Kushki es lenta
  // (varios segundos) y bloqueaba el render de "Pagar" en CADA carga, para
  // todos — aunque casi nadie use PSE. El PseSheet del cliente pide la lista
  // solo cuando el diner abre PSE (GET /pay/pse-banks, ahora con caché),
  // así "Pagar" abre al instante.
  const enabledMethods = resolveEnabledPaymentMethods(
    tenant.enabledPaymentMethods,
  );
  const pseBanks: Array<{ code: string; name: string }> = [];

  // Mesero usa su propia PWA con bottom nav (Salón/Cobros/Mesas) y
  // está bloqueado por el guard de /operator/*. Operator y platform_admin
  // vuelven a las pantallas del backoffice.
  const isMeseroSession = session?.user?.role === "mesero";
  const staffHomeHref = isMeseroSession ? "/mesero/mesas" : "/operator/tables";
  const staffServeHref = isMeseroSession ? "/mesero/salon" : "/operator/serve";
  // Tras un cobro exitoso, la pantalla de "listo" (con la factura) debe
  // quedar DENTRO del scope del que cobra: el mesero en su PWA (con bottom
  // nav), el operador/admin en la página done del comensal en modo op.
  const doneHref = isMeseroSession
    ? `/mesero/cobrar/${orderId}/done`
    : `/t/${slug}/pay/${orderId}/done?op=1`;

  return (
    <PayClient
      operatorMode={operatorMode}
      staffHomeHref={staffHomeHref}
      staffServeHref={staffServeHref}
      doneHref={doneHref}
      tenantSlug={slug}
      tenantName={tenant.name}
      orderId={order.id}
      shortCode={order.shortCode}
      tableId={order.table.id}
      locationLabel={
        tenant.serviceMode === "counter"
          ? "Mostrador"
          : `Mesa ${order.table.number}`
      }
      subtotalCents={order.subtotalCents}
      paidCents={paidCents}
      paidTipCents={paidTipCents}
      alreadyPaid={order.status === "paid"}
      items={order.items.map((i) => ({
        id: i.id,
        name: i.nameSnapshot,
        qty: i.qty,
        priceCents: i.priceCentsSnapshot,
        guestName: i.guestName,
      }))}
      serviceMode={tenant.serviceMode}
      kushkiReady={kushkiReady}
      kushkiPublicKey={tenant.kushkiPublicKey}
      kushkiMode={await getRestaurantKushkiMode(tenant)}
      currency={await getCurrencyForCountry(tenant.country)}
      card3ds={tenant.kushkiCard3ds}
      enabledMethods={enabledMethods}
      pseBanks={pseBanks}
      assignedDeviceId={assignedDevice?.kushkiDeviceId ?? null}
      assignedDeviceLabel={assignedDevice?.label ?? null}
      // Banner que se muestra al volver de un cobro rechazado por
      // datáfono o PSE — sirve para que el diner entienda por qué
      // volvió al checkout y elija otro método.
      declinedFlag={declined === "1"}
    />
  );
}
