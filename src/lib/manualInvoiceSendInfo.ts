import { db } from "@/lib/db";
import { displayOrderCode } from "@/lib/orderCode";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";
import {
  manualInvoicePayLinkAvailability,
  manualInvoicePayLinkPath,
  payLinkOnlineMethods,
  payLinkSentTo,
  payLinkState,
  receivablePayLinkState,
  type PayLinkTenant,
} from "@/lib/manualInvoicePayLink";
import { loadReceivableCharge, type ReceivableCharge } from "@/lib/manualInvoiceReceivable";
import type { ManualInvoiceSendInfo } from "@/components/manualInvoice/types";

/**
 * Arma lo que la UI de "Emitir y enviar factura" necesita de una factura
 * manual. Puro (sin DB) para que la grilla de Mesas lo calcule para todas
 * sus facturas abiertas con lo que ya cargó; `loadManualInvoiceSendInfo`
 * es la versión que lee todo para UNA orden (ficha y lista de Órdenes).
 */
export type SendInfoLink = {
  token: string;
  status: string;
  expiresAt: Date | null;
  payerEmail: string | null;
  emailRecipients: string[];
  emailSentAt: Date | null;
  openedAt: Date | null;
  method: string | null;
  paidAt: Date | null;
  creditPaymentId: string | null;
};

export const SEND_INFO_LINK_SELECT = {
  token: true,
  status: true,
  expiresAt: true,
  payerEmail: true,
  emailRecipients: true,
  emailSentAt: true,
  openedAt: true,
  method: true,
  paidAt: true,
  creditPaymentId: true,
} as const;

export const SEND_INFO_TENANT_SELECT = {
  name: true,
  slug: true,
  country: true,
  kushkiMerchantId: true,
  kushkiOnboardingStatus: true,
  enabledPaymentMethods: true,
  kushkiBreBPublicKey: true,
  kushkiBreBPrivateKeyEnc: true,
} as const;

export function buildManualInvoiceSendInfo(args: {
  order: {
    id: string;
    shortCode: string;
    status: string;
    subtotalCents: number;
    taxCents: number;
    discountCents: number;
    /** Pagos APROBADOS (lo pagado de comida descuenta del saldo). */
    approvedPayments: readonly { amountCents: number; tipCents: number }[];
  };
  tenant: PayLinkTenant & { name: string; slug: string };
  currency: string;
  /** Origen público para armar la URL del link. */
  origin: string;
  link: SendInfoLink | null;
  /** Número de la factura, si ya existe. */
  invoiceNumber: string | null;
  /** Correo del cliente de la factura (solicitud de la cuenta). */
  customerEmail: string | null;
  /** Nombre del cliente de la factura. */
  customerName?: string | null;
  /** Factura emitida por cobrar: el saldo de su cargo y el cliente. */
  receivable?: { charge: ReceivableCharge; customerName: string | null } | null;
  now?: number;
}): ManualInvoiceSendInfo {
  const now = args.now ?? Date.now();
  const methods = payLinkOnlineMethods(args.tenant, args.currency);
  const receivable = args.receivable ?? null;
  const open = args.order.status !== "paid" && args.order.status !== "cancelled";
  const paidFood = args.order.approvedPayments.reduce((s, p) => s + Math.max(0, p.amountCents - p.tipCents), 0);
  const outstandingCents = receivable
    ? receivable.charge.outstandingCents
    : Math.max(0, args.order.subtotalCents + args.order.taxCents - args.order.discountCents - paidFood);

  const availability = receivable
    ? methods.length > 0
      ? ({ ok: true } as const)
      : ({ ok: false, reason: "online_payments_unavailable" } as const)
    : manualInvoicePayLinkAvailability({
        tableKind: "manual",
        orderStatus: args.order.status,
        outstandingCents,
        tenant: args.tenant,
        currency: args.currency,
      });

  const link = args.link;
  const state = link
    ? receivable
      ? receivablePayLinkState(link, receivable.charge, now)
      : payLinkState(link, args.order, now)
    : null;
  // Un link pagado/anulado no se reenvía; uno vencido sí (se renueva).
  const canSend = availability.ok && (state === null || state === "open" || state === "expired");

  const suggested: string[] = [];
  for (const email of [args.customerEmail, ...(link ? payLinkSentTo(link) : [])]) {
    const normalized = email?.trim().toLowerCase();
    if (normalized && !suggested.includes(normalized)) suggested.push(normalized);
  }

  return {
    orderId: args.order.id,
    orderCode: displayOrderCode(args.order.shortCode),
    tenantName: args.tenant.name,
    currency: args.currency,
    outstandingCents,
    open,
    canSend,
    unavailable: availability.ok ? null : availability.reason,
    methods,
    invoiceNumber: args.invoiceNumber,
    customerName: args.customerName ?? receivable?.customerName ?? null,
    suggestedEmails: suggested,
    link:
      link && state
        ? {
            url: `${args.origin}${manualInvoicePayLinkPath(args.tenant.slug, link.token)}`,
            expiresAt: (link.expiresAt ?? new Date(now)).toISOString(),
            state,
            sentTo: payLinkSentTo(link),
            sentAt: link.emailSentAt?.toISOString() ?? null,
            openedAt: link.openedAt?.toISOString() ?? null,
            paidMethod: link.status === "paid" ? link.method : null,
            paidAt: link.status === "paid" ? link.paidAt?.toISOString() ?? null : null,
          }
        : null,
    receivable: receivable
      ? {
          chargeId: receivable.charge.paymentId,
          billingCustomerId: receivable.charge.billingCustomerId,
          customerName: receivable.customerName,
          totalCents: receivable.charge.totalCents,
          outstandingCents: receivable.charge.outstandingCents,
          dueDate: receivable.charge.dueDate.toISOString(),
          overdue: receivable.charge.outstandingCents > 0 && receivable.charge.dueDate.getTime() < now,
        }
      : null,
  };
}

/**
 * Lo mismo para UNA factura manual, leyendo todo (ficha de la orden, fila
 * de Órdenes). null si la orden no es una factura manual del comercio.
 */
export async function loadManualInvoiceSendInfo(args: {
  restaurantId: string;
  orderId: string;
  origin: string;
}): Promise<ManualInvoiceSendInfo | null> {
  const order = await db.order.findFirst({
    where: { id: args.orderId, restaurantId: args.restaurantId },
    select: {
      id: true,
      shortCode: true,
      status: true,
      subtotalCents: true,
      taxCents: true,
      discountCents: true,
      table: { select: { kind: true } },
      payments: { where: { status: "approved" }, select: { amountCents: true, tipCents: true } },
      invoiceRequests: { orderBy: { createdAt: "desc" }, take: 1, select: { email: true, customerName: true } },
      simpleInvoice: { select: { invoiceNumber: true, snapshot: true } },
      payLink: { select: SEND_INFO_LINK_SELECT },
      restaurant: { select: SEND_INFO_TENANT_SELECT },
    },
  });
  if (!order || order.table.kind !== "manual") return null;
  const currency = await getCurrencyForCountry(order.restaurant.country);
  const charge = order.payLink?.creditPaymentId
    ? await loadReceivableCharge(args.restaurantId, order.payLink.creditPaymentId)
    : null;
  return buildManualInvoiceSendInfo({
    order: { ...order, approvedPayments: order.payments },
    tenant: order.restaurant,
    currency,
    origin: args.origin,
    link: order.payLink,
    invoiceNumber: order.simpleInvoice
      ? formatInvoiceNumber(order.simpleInvoice.snapshot as unknown as InvoiceSnapshot, order.simpleInvoice.invoiceNumber)
      : null,
    customerEmail: order.invoiceRequests[0]?.email ?? null,
    customerName: order.invoiceRequests[0]?.customerName ?? null,
    receivable: charge ? { charge, customerName: order.invoiceRequests[0]?.customerName ?? null } : null,
  });
}
