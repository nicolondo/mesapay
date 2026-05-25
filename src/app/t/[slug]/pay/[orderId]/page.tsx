import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { env } from "@/lib/env";
import { auth } from "@/auth";
import { PayClient } from "./PayClient";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";
import { resolveEnabledPaymentMethods } from "@/lib/paymentMethods";

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; orderId: string }>;
  searchParams: Promise<{ op?: string }>;
}) {
  const { slug, orderId } = await params;
  const sp = await searchParams;
  // Operator-mode pay flow: a waiter is collecting the bill on behalf
  // of a diner who doesn't have a phone or who asked verbally. We
  // honour ?op=1 only if the session belongs to a real operator —
  // never trust the URL alone.
  const session = sp.op === "1" ? await auth() : null;
  const operatorMode =
    !!session?.user &&
    (session.user.role === "operator" ||
      session.user.role === "platform_admin");
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
      items: { orderBy: { id: "asc" } },
    },
  });
  if (!order || order.restaurantId !== tenant.id) return notFound();

  const approved = order.payments.filter((p) => p.status === "approved");
  const paidCents = approved.reduce((s, p) => s + p.amountCents, 0);
  const paidTipCents = approved.reduce((s, p) => s + p.tipCents, 0);
  const kushkiReady =
    !!tenant.kushkiMerchantId && tenant.kushkiOnboardingStatus === "active";

  return (
    <PayClient
      operatorMode={operatorMode}
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
      isMockMode={env.KUSHKI_MODE === "mock"}
      enabledMethods={resolveEnabledPaymentMethods(tenant.enabledPaymentMethods)}
    />
  );
}
