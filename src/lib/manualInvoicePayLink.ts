import type { Prisma } from "@prisma/client";
import { newPaymentLinkToken } from "@/lib/paymentLinks";
import { enabledOnlineMethods, onlinePaymentsReady, type OnlinePaymentsTenant } from "@/lib/payments/onlinePayments";

/**
 * LINK DE PAGO DE UNA FACTURA MANUAL.
 *
 * El dueño lo pidió así: "para las facturas manuales necesito poder mandar
 * un link de pago al cliente cuando se tiene Kushki ya activo". Una factura
 * manual es una `Order` sobre una mesa oculta `kind = manual` (ver
 * src/lib/manualInvoice.ts); nadie la escanea, así que el cliente no tiene
 * cómo llegar al checkout del comensal. Este link es esa puerta:
 *
 *   /r/[slug]/cuenta/[token]  →  valida el token y el estado de la cuenta,
 *                                 deja la cookie de invitado SÓLO para esa
 *                                 orden (`grantGuestAccess({ orderId })`) y
 *                                 redirige a /t/[slug]/pay/[orderId].
 *
 * A partir de ahí es el cobro de siempre (tarjeta, PSE, Apple Pay, 3DS,
 * webhook, "listo" con factura/DIAN): no hay un segundo camino de
 * liquidación. El link es una fila de `PaymentLink` con `kind = order`:
 *
 *   - `token` aleatorio (144 bits), nunca el id de la orden.
 *   - Uno por orden (`orderId` único): reenviar reutiliza la misma URL; si
 *     venció, se rota el token y el viejo deja de servir.
 *   - `amountCents` = saldo al crearlo, sólo informativo. La página cobra
 *     el saldo VIVO de la orden.
 *   - `status` se queda en `pending`: el estado real sale de la orden
 *     (`payLinkState`): pagada en caja → "pagado"; descartada → "anulado";
 *     pasado `expiresAt` → "vencido". Así no hay que enganchar cada camino
 *     por el que una cuenta se cierra.
 */

/** Vida del link: una semana desde que se crea (o se revive). */
export const MANUAL_INVOICE_PAY_LINK_TTL_MS = 7 * 24 * 3600_000;

export function manualInvoicePayLinkPath(slug: string, token: string): string {
  return `/r/${encodeURIComponent(slug)}/cuenta/${encodeURIComponent(token)}`;
}

/** Página de estado (pagado / anulado / vencido) del mismo link. */
export function manualInvoicePayLinkStatusPath(slug: string, token: string): string {
  return `${manualInvoicePayLinkPath(slug, token)}/estado`;
}

export type PayLinkState = "open" | "paid" | "cancelled" | "expired";

/**
 * Estado efectivo del link, derivado de la ORDEN (fuente de verdad) y de la
 * caducidad del link. `paid` y `cancelled` mandan sobre `expired`: una
 * cuenta pagada se muestra como pagada aunque el link haya vencido.
 */
export function payLinkState(
  link: { status: string; expiresAt: Date | null },
  order: { status: string },
  now: number = Date.now(),
): PayLinkState {
  if (order.status === "paid") return "paid";
  if (order.status === "cancelled" || link.status === "cancelled") return "cancelled";
  if (link.status === "paid") return "paid";
  if (link.expiresAt && link.expiresAt.getTime() <= now) return "expired";
  return "open";
}

export type PayLinkUnavailableReason =
  | "not_manual_invoice"
  | "order_closed"
  | "nothing_to_pay"
  | "online_payments_unavailable";

export type PayLinkAvailability = { ok: true } | { ok: false; reason: PayLinkUnavailableReason };

/**
 * Gate del botón y de la API: sólo una factura manual abierta, con saldo, de
 * un comercio con Kushki activo y algún medio en línea habilitado. El orden
 * de las razones importa: la primera que falla es la que se informa.
 */
export function manualInvoicePayLinkAvailability(args: {
  tableKind: string;
  orderStatus: string;
  outstandingCents: number;
  tenant: OnlinePaymentsTenant & { enabledPaymentMethods: unknown };
}): PayLinkAvailability {
  if (args.tableKind !== "manual") return { ok: false, reason: "not_manual_invoice" };
  if (args.orderStatus === "paid" || args.orderStatus === "cancelled") {
    return { ok: false, reason: "order_closed" };
  }
  if (args.outstandingCents <= 0) return { ok: false, reason: "nothing_to_pay" };
  if (!onlinePaymentsReady(args.tenant) || enabledOnlineMethods(args.tenant.enabledPaymentMethods).length === 0) {
    return { ok: false, reason: "online_payments_unavailable" };
  }
  return { ok: true };
}

export type EnsuredPayLink = {
  id: string;
  token: string;
  expiresAt: Date;
  payerEmail: string | null;
  emailSentAt: Date | null;
  /** true si el link es nuevo o se rotó el token (el anterior ya no sirve). */
  rotated: boolean;
};

/**
 * Deja un link ABIERTO para la orden: lo crea si no existe; si existe y
 * sigue vigente, lo reutiliza (misma URL, se refresca el saldo
 * informativo); si venció o fue anulado, rota el token y le da una vida
 * nueva. Se llama dentro de una transacción junto con lo que lo dispara.
 */
export async function ensureManualInvoicePayLinkInTx(
  tx: Prisma.TransactionClient,
  args: { restaurantId: string; orderId: string; amountCents: number; currency: string; now?: Date },
): Promise<EnsuredPayLink> {
  const now = args.now ?? new Date();
  const expiresAt = new Date(now.getTime() + MANUAL_INVOICE_PAY_LINK_TTL_MS);
  const existing = await tx.paymentLink.findUnique({
    where: { orderId: args.orderId },
    select: { id: true, token: true, status: true, expiresAt: true, payerEmail: true, emailSentAt: true },
  });
  if (!existing) {
    const created = await tx.paymentLink.create({
      data: {
        restaurantId: args.restaurantId,
        token: newPaymentLinkToken(),
        kind: "order",
        orderId: args.orderId,
        amountCents: args.amountCents,
        currency: args.currency,
        expiresAt,
      },
      select: { id: true, token: true, expiresAt: true, payerEmail: true, emailSentAt: true },
    });
    return { ...created, expiresAt: created.expiresAt ?? expiresAt, rotated: true };
  }
  const stale =
    existing.status !== "pending" ||
    (existing.expiresAt !== null && existing.expiresAt.getTime() <= now.getTime());
  const updated = await tx.paymentLink.update({
    where: { id: existing.id },
    data: stale
      ? { token: newPaymentLinkToken(), status: "pending", expiresAt, amountCents: args.amountCents, currency: args.currency }
      : { amountCents: args.amountCents, currency: args.currency },
    select: { id: true, token: true, expiresAt: true, payerEmail: true, emailSentAt: true },
  });
  return { ...updated, expiresAt: updated.expiresAt ?? expiresAt, rotated: stale };
}

/** Deja constancia del último envío por correo (a quién y cuándo). */
export async function recordManualInvoicePayLinkEmail(
  tx: Prisma.TransactionClient,
  linkId: string,
  email: string,
  now: Date = new Date(),
): Promise<void> {
  await tx.paymentLink.update({
    where: { id: linkId },
    data: { payerEmail: email, emailSentAt: now },
  });
}
