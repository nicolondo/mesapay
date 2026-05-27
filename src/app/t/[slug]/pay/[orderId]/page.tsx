import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { getKushkiMode } from "@/lib/platformConfig";
import { auth } from "@/auth";
import { PayClient } from "./PayClient";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";
import { resolveEnabledPaymentMethods } from "@/lib/paymentMethods";
import { getAssignedDevice } from "@/lib/meseroDevice";

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; orderId: string }>;
  searchParams: Promise<{ op?: string; declined?: string }>;
}) {
  const { slug, orderId } = await params;
  const sp = await searchParams;
  // Operator-mode pay flow: el staff está cobrando la cuenta en
  // nombre de un comensal que no tiene celular o pidió verbalmente.
  // Sólo honramos ?op=1 si la sesión es staff real — nunca confiar
  // en la URL sola. Incluimos `mesero` porque desde su PWA tiene
  // un botón "Cobrar la cuenta" que apunta acá; sin este rol caía
  // al flow del cliente con "Partes iguales / Lo mío".
  const session = sp.op === "1" ? await auth() : null;
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

  // Mesero usa su propia PWA con bottom nav (Salón/Cobros/Mesas) y
  // está bloqueado por el guard de /operator/*. Operator y platform_admin
  // vuelven a las pantallas del backoffice.
  const isMeseroSession = session?.user?.role === "mesero";
  const staffHomeHref = isMeseroSession ? "/mesero/mesas" : "/operator/tables";
  const staffServeHref = isMeseroSession ? "/mesero/salon" : "/operator/serve";

  return (
    <PayClient
      operatorMode={operatorMode}
      staffHomeHref={staffHomeHref}
      staffServeHref={staffServeHref}
      tenantSlug={slug}
      tenantName={tenant.name}
      orderId={order.id}
      shortCode={order.shortCode}
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
      isMockMode={(await getKushkiMode()) === "mock"}
      enabledMethods={resolveEnabledPaymentMethods(tenant.enabledPaymentMethods)}
      assignedDeviceId={assignedDevice?.kushkiDeviceId ?? null}
      assignedDeviceLabel={assignedDevice?.label ?? null}
      // Banner que se muestra al volver de un cobro rechazado por
      // datáfono o PSE — sirve para que el diner entienda por qué
      // volvió al checkout y elija otro método.
      declinedFlag={sp.declined === "1"}
    />
  );
}
