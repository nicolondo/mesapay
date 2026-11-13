import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { OPERATOR_ROLES } from "@/lib/staffAccess";
import { isScopeError, requireOperatorScope } from "@/lib/operatorScope";
import { recordAuditEvent } from "@/lib/auditLog";
import { appOrigin } from "@/lib/http/publicOrigin";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { syncOrderSubtotalFromLiveItems } from "@/lib/orderTotals";
import { publishOrderEvent } from "@/lib/events";
import { issueInvoiceOnPaid } from "@/lib/invoiceOnPaid";
import { isModuleEnabled } from "@/lib/modules";
import {
  MAX_PAY_LINK_RECIPIENTS,
  ensureManualInvoicePayLinkInTx,
  manualInvoicePayLinkAvailability,
  manualInvoicePayLinkPath,
  parsePayLinkRecipients,
  payLinkOnlineMethods,
  payLinkSentTo,
  receivablePayLinkExpiry,
  recordManualInvoicePayLinkEmail,
  type EnsuredPayLink,
  type PayLinkState,
} from "@/lib/manualInvoicePayLink";
import { issueManualInvoiceReceivable, refreshReceivablePayLink } from "@/lib/manualInvoiceReceivable";
import { sendManualInvoicePayLinkEmail } from "@/lib/manualInvoicePayLinkEmail";
import { payLinkInvoiceFor } from "@/lib/manualInvoicePayLinkInvoice";

export const dynamic = "force-dynamic";

/**
 * POST /api/operator/orders/[id]/pay-link — envío de una FACTURA MANUAL con
 * su link de pago. Un solo link por orden: lo que se copia, lo que va por
 * WhatsApp y lo que llega por correo es la misma URL.
 *
 * Tres momentos, misma ruta:
 *
 *   · Cuenta ABIERTA, sin `issue`: deja un link abierto (lo crea, lo
 *     reutiliza o lo renueva si venció) que lleva al checkout de la orden.
 *     La cuenta sigue en Mesas hasta que el cliente pague.
 *   · Cuenta ABIERTA, con `issue: true` — "Emitir y enviar factura": cierra
 *     la cuenta a crédito del cliente de la factura (sale de Mesas y pasa a
 *     Cartera), emite la factura (electrónica o comprobante) y el link pasa
 *     a cobrar ese saldo (src/lib/manualInvoiceReceivable.ts).
 *   · Factura YA EMITIDA POR COBRAR: reenvío. Pone el monto al día con el
 *     saldo del cargo y, si el link venció, lo renueva.
 *
 * Con `emails` (o el viejo `email`) manda el correo con la factura y el
 * link a cada destinatario (hasta 5). Sólo caja (operador o quien lo
 * impersona). Los errores van como CÓDIGO: MESAPAY es trilingüe y el
 * cliente los traduce.
 *
 * Respuesta: { url, expiresAt, state, sentTo[], sentAt, openedAt, rotated,
 * receivable, failed? , emailFailed? }.
 */
const schema = z.object({
  email: z.string().max(160).optional(),
  emails: z.array(z.string().max(160)).max(MAX_PAY_LINK_RECIPIENTS * 2).optional(),
  issue: z.boolean().optional(),
});

async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = await requireOperatorScope(OPERATOR_ROLES);
  if (isScopeError(scope)) {
    return NextResponse.json({ error: scope.error }, { status: scope.error === "forbidden" ? 403 : 400 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const recipients = parsePayLinkRecipients(parsed.data);
  if (!recipients.ok) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const emails = recipients.emails;

  const { id: orderId } = await params;
  // Saldo vivo antes de mirar si hay algo que cobrar (un plato cancelado
  // en otra pestaña no debe dejar un link por un total viejo).
  await syncOrderSubtotalFromLiveItems(orderId);
  const order = await db.order.findFirst({
    where: { id: orderId, restaurantId: scope.restaurantId },
    select: {
      id: true,
      status: true,
      shortCode: true,
      locale: true,
      subtotalCents: true,
      taxCents: true,
      discountCents: true,
      table: { select: { kind: true } },
      payments: { where: { status: "approved" }, select: { amountCents: true, tipCents: true, method: true } },
      items: {
        where: { cancelledAt: null, OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }] },
        orderBy: { id: "asc" },
        select: { nameSnapshot: true, qty: true, priceCentsSnapshot: true },
      },
      // La más reciente, pendiente o ya facturada: el cliente de la factura.
      invoiceRequests: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { customerName: true },
      },
      payLink: {
        select: {
          id: true,
          restaurantId: true,
          token: true,
          status: true,
          expiresAt: true,
          amountCents: true,
          payerEmail: true,
          emailRecipients: true,
          emailSentAt: true,
          openedAt: true,
          creditPaymentId: true,
        },
      },
      restaurant: {
        select: {
          name: true,
          slug: true,
          country: true,
          enabledModules: true,
          kushkiMerchantId: true,
          kushkiOnboardingStatus: true,
          enabledPaymentMethods: true,
          kushkiBreBPublicKey: true,
          kushkiBreBPrivateKeyEnc: true,
        },
      },
    },
  });
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (order.table.kind !== "manual") return NextResponse.json({ error: "not_manual_invoice" }, { status: 409 });

  const currency = await getCurrencyForCountry(order.restaurant.country);
  const methods = payLinkOnlineMethods(order.restaurant, currency);
  const einvoicing = isModuleEnabled(order.restaurant.enabledModules, "einvoicing");
  const now = new Date();

  let link: EnsuredPayLink;
  const state: PayLinkState = "open";
  let amountCents: number;
  let receivable: { dueDate: Date } | null = null;
  let issuedNow = false;

  if (order.payLink?.creditPaymentId) {
    // ── Factura ya emitida por cobrar: reenvío / renovación ──────────────
    const fresh = await refreshReceivablePayLink(order.payLink);
    if (!fresh.charge || fresh.state === "paid" || fresh.state === "cancelled") {
      return NextResponse.json({ error: "receivable_closed", state: fresh.state }, { status: 409 });
    }
    if (methods.length === 0) return NextResponse.json({ error: "online_payments_unavailable" }, { status: 409 });
    const terms = Math.max(0, Math.round((fresh.charge.dueDate.getTime() - now.getTime()) / 86_400_000));
    link = await db.$transaction((tx) =>
      ensureManualInvoicePayLinkInTx(tx, {
        restaurantId: scope.restaurantId,
        orderId: order.id,
        amountCents: fresh.charge!.outstandingCents,
        currency,
        now,
        creditPaymentId: fresh.charge!.paymentId,
        // Renovar un link vencido le da otra semana (o hasta el vencimiento
        // de la factura, si es más lejos).
        expiresAt: receivablePayLinkExpiry(now, terms),
      }),
    );
    amountCents = fresh.charge.outstandingCents;
    receivable = { dueDate: fresh.charge.dueDate };
  } else {
    // ── Cuenta abierta ──────────────────────────────────────────────────
    // Mismo cálculo del saldo que el checkout: neto del descuento, menos lo
    // ya pagado de comida (sin propinas).
    const paidFood = order.payments.reduce((s, p) => s + Math.max(0, p.amountCents - p.tipCents), 0);
    const outstandingCents = Math.max(0, order.subtotalCents + order.taxCents - order.discountCents - paidFood);
    const availability = manualInvoicePayLinkAvailability({
      tableKind: order.table.kind,
      orderStatus: order.status,
      outstandingCents,
      tenant: order.restaurant,
      currency,
    });
    if (!availability.ok) return NextResponse.json({ error: availability.reason }, { status: 409 });

    if (parsed.data.issue) {
      const issued = await issueManualInvoiceReceivable({
        restaurantId: scope.restaurantId,
        orderId: order.id,
        userId: scope.userId ?? null,
        currency,
        now,
      });
      if (!issued.ok) return NextResponse.json({ error: issued.error }, { status: 409 });
      issuedNow = true;
      link = issued.link;
      amountCents = issued.amountCents;
      receivable = { dueDate: issued.dueDate };
      // Sale de Mesas, Salón y el datáfono al instante.
      publishOrderEvent(scope.restaurantId, { type: "order.paid", orderId: order.id });
      // La factura, por el riel de siempre. Se espera la DIAN para que el
      // correo lleve el CUFE y el XML si responde rápido; si no, el correo
      // lo dice y la factura electrónica llega sola al aceptarla.
      await issueInvoiceOnPaid({ tenantId: scope.restaurantId, orderId: order.id, emit: "inline" });
      await recordAuditEvent({
        kind: "order.manual_invoice.issue_receivable",
        restaurantId: scope.restaurantId,
        target: { type: "order", id: order.id },
        summary: `Emitió la factura manual ${order.shortCode} por cobrar`,
        diff: {
          after: {
            amountCents: issued.amountCents,
            billingCustomerId: issued.billingCustomerId,
            paymentId: issued.paymentId,
            dueDate: issued.dueDate.toISOString(),
          },
        },
      });
    } else {
      link = await db.$transaction((tx) =>
        ensureManualInvoicePayLinkInTx(tx, {
          restaurantId: scope.restaurantId,
          orderId: order.id,
          amountCents: outstandingCents,
          currency,
          now,
        }),
      );
      amountCents = outstandingCents;
    }
  }

  const url = `${appOrigin(req)}${manualInvoicePayLinkPath(order.restaurant.slug, link.token)}`;
  if (link.rotated && !issuedNow) {
    await recordAuditEvent({
      kind: "order.manual_invoice.pay_link.create",
      restaurantId: scope.restaurantId,
      target: { type: "order", id: order.id },
      summary: `Creó link de pago de la factura manual ${order.shortCode}`,
      diff: { after: { expiresAt: link.expiresAt.toISOString(), amountCents } },
    });
  }

  let sentTo = payLinkSentTo(link);
  let sentAt = link.emailSentAt;
  let failed: string[] = [];
  if (emails.length > 0) {
    const { invoice, attachments } = await payLinkInvoiceFor({
      restaurantId: scope.restaurantId,
      orderId: order.id,
      einvoicing,
    });
    const result = await sendManualInvoicePayLinkEmail({
      to: emails,
      locale: order.locale,
      restaurantName: order.restaurant.name,
      orderCode: order.shortCode,
      totalCents: amountCents,
      currency,
      lines: order.items.map((i) => ({ name: i.nameSnapshot, qty: i.qty, amountCents: i.priceCentsSnapshot * i.qty })),
      payUrl: url,
      expiresAt: link.expiresAt,
      customerName: order.invoiceRequests[0]?.customerName ?? null,
      invoice,
      methods,
      dueDate: receivable?.dueDate ?? null,
      attachments,
    });
    failed = result.failed;
    if (result.sent.length > 0) {
      await db.$transaction((tx) => recordManualInvoicePayLinkEmail(tx, link.id, result.sent, now));
      sentTo = result.sent;
      sentAt = now;
      await recordAuditEvent({
        kind: "order.manual_invoice.pay_link.email",
        restaurantId: scope.restaurantId,
        target: { type: "order", id: order.id },
        summary: `Envió la factura manual ${order.shortCode} con su link de pago a ${result.sent.join(", ")}`,
      });
    } else if (!issuedNow) {
      // Nada salió y no había nada más que hacer: el envío falló.
      return NextResponse.json(
        {
          error: "email_failed",
          url,
          expiresAt: link.expiresAt.toISOString(),
          sentTo,
          sentAt: sentAt?.toISOString() ?? null,
          failed,
        },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({
    url,
    expiresAt: link.expiresAt.toISOString(),
    state,
    sentTo,
    sentAt: sentAt?.toISOString() ?? null,
    openedAt: link.openedAt?.toISOString() ?? null,
    rotated: link.rotated,
    issued: issuedNow,
    receivable: receivable ? { amountCents, dueDate: receivable.dueDate.toISOString() } : null,
    ...(failed.length > 0 ? { failed } : {}),
    // Emitida y por cobrar, pero el correo no salió: el operador copia el link.
    ...(issuedNow && emails.length > 0 && failed.length === emails.length ? { emailFailed: true } : {}),
  });
}

export const POST = secureApi(POSTHandler);
