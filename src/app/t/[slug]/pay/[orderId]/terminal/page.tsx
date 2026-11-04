import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { OPERATOR_ROLES, staffForRestaurant } from "@/lib/staffAccess";
import { terminalClaimKey } from "@/lib/payments/methods";
import { TERMINAL_CANCELED_REASON, toTerminalAttemptView } from "@/lib/payments/terminalAttempt";
import { canResolveTerminalCharge } from "@/lib/payments/terminalResolve";
import { TerminalWait } from "./TerminalWait";

export const dynamic = "force-dynamic";

export default async function TerminalPendingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; orderId: string }>;
  searchParams: Promise<{ pid?: string; op?: string }>;
}) {
  const { slug, orderId } = await params;
  const { pid, op } = await searchParams;

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { restaurant: true, table: true },
  });
  if (!order || order.restaurant.slug !== slug) notFound();

  // The URL flag is not staff authorization. Both success and retry retain
  // the verified staff's scope; the waiter stays inside the installed PWA.
  const staff = op === "1"
    ? await staffForRestaurant(order.restaurantId, [...OPERATOR_ROLES, "mesero"])
    : null;
  const checkoutHref = staff?.user.role === "mesero"
    ? `/mesero/cobrar/${orderId}`
    : `/t/${slug}/pay/${orderId}${staff ? "?op=1" : ""}`;
  const doneHref = staff?.user.role === "mesero"
    ? `/mesero/cobrar/${orderId}/done`
    : `/t/${slug}/pay/${orderId}/done?pid=${encodeURIComponent(pid ?? "")}${staff ? "&op=1" : ""}`;

  const payment = pid
    ? await db.payment.findUnique({ where: { id: pid } })
    : null;
  if (!payment || payment.orderId !== order.id) notFound();
  // Aceptamos ambos métodos de datáfono: el cloud-pushed de Kushki
  // (kushki_card_terminal) y el datáfono propio del comercio
  // (external_terminal). El waiting screen es el mismo en ambos —
  // sólo cambia quién settlea (Kushki webhook vs mesero manualmente
  // desde Salón).
  if (
    payment.method !== "kushki_card_terminal" &&
    payment.method !== "external_terminal"
  ) {
    notFound();
  }

  const tMenu = await getTranslations("menu");
  // El reclamo del datáfono Kushki: si se canceló en el equipo o se
  // reintentó (la pantalla vuelve con su aviso o sigue al pago nuevo) y, sólo
  // para el staff, qué se sabe del cobro enviado (para cancelar en el equipo,
  // reintentar o cobrar de otra forma ahí mismo).
  const claim =
    payment.method === "kushki_card_terminal" && payment.status !== "approved"
      ? await db.financialOperation.findUnique({ where: { key: terminalClaimKey(payment.id) } })
      : null;
  const declined = payment.status === "declined";
  const retrySep = checkoutHref.includes("?") ? "&" : "?";

  return (
    <TerminalWait
      // Un reintento cambia de pago (`pid`): pantalla nueva, estado nuevo.
      key={payment.id}
      tenantSlug={slug}
      tenantName={order.restaurant.name}
      locationLabel={
        order.restaurant.serviceMode === "counter"
          ? tMenu("counter")
          : tMenu("tableLabel", { number: order.table.number })
      }
      orderId={order.id}
      paymentId={payment.id}
      // payment.amountCents ya es el TOTAL (food + tip) — no hay que
      // sumar tipCents de nuevo o se duplica la propina en pantalla.
      amountCents={payment.amountCents}
      initialStatus={payment.status}
      initialOrderStatus={order.status}
      doneHref={doneHref}
      continueHref={staff ? checkoutHref : undefined}
      retryHref={`${checkoutHref}${retrySep}declined=1`}
      canceledHref={`${checkoutHref}${retrySep}declined=canceled`}
      initialDeclineReason={declined && claim?.answeredAt ? TERMINAL_CANCELED_REASON : null}
      initialNextPaymentId={declined ? (claim?.nextPaymentId ?? null) : null}
      initialAttempt={
        staff && payment.status === "pending" ? toTerminalAttemptView(claim, payment.reconciliationRequired) : null
      }
      canResolveTerminal={canResolveTerminalCharge(staff?.user.role)}
    />
  );
}
