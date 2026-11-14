import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { newPaymentLinkToken } from "@/lib/paymentLinks";
import { offerablePaymentMethods } from "@/lib/paymentMethods";
import { onlinePaymentsReady, type OnlinePaymentsTenant } from "@/lib/payments/onlinePayments";

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
 *
 * FACTURA EMITIDA POR COBRAR ("Emitir y enviar factura",
 * src/lib/manualInvoiceReceivable.ts): la cuenta se cierra a crédito del
 * cliente y el MISMO link (misma fila, mismo token si sigue vigente) pasa
 * a cobrar ese cargo: `creditPaymentId` apunta al Payment customer_credit,
 * la URL lleva a la página de monto fijo (/r/[slug]/pago/[token]) y, al
 * pagarse, deja un abono dirigido a ese cargo (`paymentLinks.applyPaidEffect`).
 * Su estado sale del saldo del cargo (`receivablePayLinkState`).
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

/**
 * Estado de un link de factura EMITIDA POR COBRAR, a partir del saldo de su
 * cargo a crédito (abonos dirigidos y FIFO, `customerCredit.allocateFifo`):
 *   - el cargo ya no pesa (nota crédito que anuló la factura, devolución) → anulado;
 *   - sin saldo (pagado por el link o registrado desde Cartera) → pagado;
 *   - pasado `expiresAt` → vencido (reenviarlo lo renueva).
 */
export function receivablePayLinkState(
  link: { status: string; expiresAt: Date | null },
  charge: { totalCents: number; outstandingCents: number },
  now: number = Date.now(),
): PayLinkState {
  if (link.status === "cancelled") return "cancelled";
  if (link.status === "paid") return "paid";
  if (charge.totalCents <= 0) return "cancelled";
  if (charge.outstandingCents <= 0) return "paid";
  if (link.expiresAt && link.expiresAt.getTime() <= now) return "expired";
  return "open";
}

/** Vida del link de una factura por cobrar: el plazo del cliente, mínimo una semana. */
export function receivablePayLinkExpiry(now: Date, creditTermsDays: number): Date {
  const terms = Math.max(0, creditTermsDays) * 24 * 3600_000;
  return new Date(now.getTime() + Math.max(MANUAL_INVOICE_PAY_LINK_TTL_MS, terms));
}

export type PayLinkUnavailableReason =
  | "not_manual_invoice"
  | "order_closed"
  | "nothing_to_pay"
  | "online_payments_unavailable";

export type PayLinkAvailability = { ok: true } | { ok: false; reason: PayLinkUnavailableReason };

/** Lo que hace falta del comercio para saber qué medios en línea ofrece el link. */
export type PayLinkTenant = OnlinePaymentsTenant & {
  enabledPaymentMethods: unknown;
  kushkiBreBPublicKey?: string | null;
  kushkiBreBPrivateKeyEnc?: string | null;
};

/** Medios EN LÍNEA (no presenciales) de Kushki, en el orden en que se ofrecen. */
export const PAY_LINK_ONLINE_METHODS = ["kushki_card", "kushki_apple_pay", "kushki_pse", "kushki_bre_b"] as const;
export type PayLinkOnlineMethod = (typeof PAY_LINK_ONLINE_METHODS)[number];

/**
 * Medios que ve quien abre el link, con las MISMAS reglas que las dos
 * páginas de cobro a las que lleva (el checkout de la orden y la de monto
 * fijo): tarjeta, Apple Pay y PSE con el comercio de Kushki activo; Bre-B
 * con sus propias llaves y sólo en pesos. Nunca efectivo ni datáfono: el
 * cliente no está en el local. Apple Pay, además, sólo aparece si el
 * aparato del cliente lo admite (lo decide su navegador).
 */
export function payLinkOnlineMethods(tenant: PayLinkTenant, currency: string): PayLinkOnlineMethod[] {
  const offerable = offerablePaymentMethods(tenant.enabledPaymentMethods, tenant);
  const ready = onlinePaymentsReady(tenant);
  return PAY_LINK_ONLINE_METHODS.filter((m) => {
    if (!offerable.includes(m)) return false;
    if (m === "kushki_bre_b") return currency === "COP";
    return ready;
  });
}

/**
 * Gate del botón y de la API: sólo una factura manual abierta, con saldo, de
 * un comercio con algún medio en línea que ofrecer. El orden de las razones
 * importa: la primera que falla es la que se informa.
 */
export function manualInvoicePayLinkAvailability(args: {
  tableKind: string;
  orderStatus: string;
  outstandingCents: number;
  tenant: PayLinkTenant;
  /** Moneda del comercio (Bre-B sólo cobra en pesos). Default COP. */
  currency?: string;
}): PayLinkAvailability {
  if (args.tableKind !== "manual") return { ok: false, reason: "not_manual_invoice" };
  if (args.orderStatus === "paid" || args.orderStatus === "cancelled") {
    return { ok: false, reason: "order_closed" };
  }
  if (args.outstandingCents <= 0) return { ok: false, reason: "nothing_to_pay" };
  if (payLinkOnlineMethods(args.tenant, args.currency ?? "COP").length === 0) {
    return { ok: false, reason: "online_payments_unavailable" };
  }
  return { ok: true };
}

/** Tope de destinatarios por envío. */
export const MAX_PAY_LINK_RECIPIENTS = 5;

const recipientSchema = z.string().trim().toLowerCase().email().max(160);

/**
 * Destinatarios del envío: el campo nuevo `emails` (lista) o el viejo
 * `email` (uno). Sin repetidos (sin importar mayúsculas), cada uno válido,
 * hasta `MAX_PAY_LINK_RECIPIENTS`. Lista vacía = no se manda correo.
 */
export function parsePayLinkRecipients(
  input: { email?: unknown; emails?: unknown },
): { ok: true; emails: string[] } | { ok: false } {
  const raw: unknown[] = [];
  if (Array.isArray(input.emails)) raw.push(...input.emails);
  else if (input.emails !== undefined) return { ok: false };
  if (input.email !== undefined && input.email !== null && input.email !== "") raw.push(input.email);
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value === "string" && value.trim() === "") continue;
    const parsed = recipientSchema.safeParse(value);
    if (!parsed.success) return { ok: false };
    if (!out.includes(parsed.data)) out.push(parsed.data);
  }
  if (out.length > MAX_PAY_LINK_RECIPIENTS) return { ok: false };
  return { ok: true, emails: out };
}

export type EnsuredPayLink = {
  id: string;
  token: string;
  expiresAt: Date;
  payerEmail: string | null;
  emailSentAt: Date | null;
  emailRecipients: string[];
  openedAt: Date | null;
  /** true si el link es nuevo o se rotó el token (el anterior ya no sirve). */
  rotated: boolean;
};

const ENSURED_SELECT = {
  id: true,
  token: true,
  expiresAt: true,
  payerEmail: true,
  emailSentAt: true,
  emailRecipients: true,
  openedAt: true,
} as const;

/**
 * Deja un link ABIERTO para la orden: lo crea si no existe; si existe y
 * sigue vigente, lo reutiliza (misma URL, se refresca el saldo
 * informativo); si venció o fue anulado, rota el token y le da una vida
 * nueva. Se llama dentro de una transacción junto con lo que lo dispara.
 *
 * Con `creditPaymentId` (factura emitida por cobrar) el link pasa a cobrar
 * ese cargo: misma fila y —si sigue vigente— mismo token, así la URL que
 * ya tenía el cliente sigue sirviendo. `expiresAt` reemplaza la vida por
 * defecto (el plazo del cliente) y, si es más larga, alarga la vigente.
 */
export async function ensureManualInvoicePayLinkInTx(
  tx: Prisma.TransactionClient,
  args: {
    restaurantId: string;
    orderId: string;
    amountCents: number;
    currency: string;
    now?: Date;
    creditPaymentId?: string;
    expiresAt?: Date;
  },
): Promise<EnsuredPayLink> {
  const now = args.now ?? new Date();
  const expiresAt = args.expiresAt ?? new Date(now.getTime() + MANUAL_INVOICE_PAY_LINK_TTL_MS);
  const existing = await tx.paymentLink.findUnique({
    where: { orderId: args.orderId },
    select: { id: true, token: true, status: true, expiresAt: true },
  });
  const receivable = args.creditPaymentId ? { creditPaymentId: args.creditPaymentId } : {};
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
        ...receivable,
      },
      select: ENSURED_SELECT,
    });
    return { ...created, expiresAt: created.expiresAt ?? expiresAt, rotated: true };
  }
  const stale =
    existing.status !== "pending" ||
    (existing.expiresAt !== null && existing.expiresAt.getTime() <= now.getTime());
  // Vigente: se alarga si la vida pedida es más larga (nunca se acorta).
  const extend =
    !stale && args.expiresAt && (existing.expiresAt === null || existing.expiresAt < args.expiresAt)
      ? { expiresAt: args.expiresAt }
      : {};
  const updated = await tx.paymentLink.update({
    where: { id: existing.id },
    data: stale
      ? {
          token: newPaymentLinkToken(),
          status: "pending",
          expiresAt,
          amountCents: args.amountCents,
          currency: args.currency,
          // Un link nuevo: nadie lo abrió todavía.
          openedAt: null,
          ...receivable,
        }
      : { amountCents: args.amountCents, currency: args.currency, ...extend, ...receivable },
    select: ENSURED_SELECT,
  });
  return { ...updated, expiresAt: updated.expiresAt ?? expiresAt, rotated: stale };
}

/**
 * Deja constancia del último envío por correo (a quiénes y cuándo).
 * `payerEmail` guarda el primero, para lo que ya lo leía.
 */
export async function recordManualInvoicePayLinkEmail(
  tx: Prisma.TransactionClient,
  linkId: string,
  emails: string | readonly string[],
  now: Date = new Date(),
): Promise<void> {
  const list = typeof emails === "string" ? [emails] : [...emails];
  await tx.paymentLink.update({
    where: { id: linkId },
    data: { payerEmail: list[0] ?? null, emailRecipients: list, emailSentAt: now },
  });
}

/** Destinatarios del último envío (los viejos sólo tienen `payerEmail`). */
export function payLinkSentTo(link: { payerEmail: string | null; emailRecipients?: readonly string[] | null }): string[] {
  if (link.emailRecipients && link.emailRecipients.length > 0) return [...link.emailRecipients];
  return link.payerEmail ? [link.payerEmail] : [];
}
