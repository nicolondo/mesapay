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
import {
  ensureManualInvoicePayLinkInTx,
  manualInvoicePayLinkAvailability,
  manualInvoicePayLinkPath,
  recordManualInvoicePayLinkEmail,
} from "@/lib/manualInvoicePayLink";
import { sendManualInvoicePayLinkEmail } from "@/lib/manualInvoicePayLinkEmail";

export const dynamic = "force-dynamic";

/**
 * POST /api/operator/orders/[id]/pay-link — link de pago de una FACTURA
 * MANUAL. Deja un link abierto para la cuenta (lo crea, lo reutiliza o lo
 * renueva si venció) y, si viene `email`, se lo manda al cliente.
 *
 * Sólo caja (operador o quien lo impersona), como abrir la factura manual.
 * El gate es el mismo del botón (`manualInvoicePayLinkAvailability`): mesa
 * `manual`, cuenta abierta con saldo y comercio con Kushki activo; si no,
 * 409 con el motivo como CÓDIGO — MESAPAY es trilingüe y el cliente lo
 * traduce.
 *
 * Respuesta: { url, expiresAt, sentTo, sentAt, rotated } (sentTo/sentAt
 * del último envío, aunque esta llamada no haya mandado nada).
 */
const schema = z.object({
  email: z.string().trim().email().max(160).optional(),
});

async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = await requireOperatorScope(OPERATOR_ROLES);
  if (isScopeError(scope)) {
    return NextResponse.json({ error: scope.error }, { status: scope.error === "forbidden" ? 403 : 400 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

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
      payments: { where: { status: "approved" }, select: { amountCents: true, tipCents: true } },
      items: {
        where: { cancelledAt: null, OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }] },
        orderBy: { id: "asc" },
        select: { nameSnapshot: true, qty: true, priceCentsSnapshot: true },
      },
      invoiceRequests: {
        where: { status: "pending" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { customerName: true },
      },
      restaurant: {
        select: {
          name: true,
          slug: true,
          country: true,
          kushkiMerchantId: true,
          kushkiOnboardingStatus: true,
          enabledPaymentMethods: true,
        },
      },
    },
  });
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Mismo cálculo del saldo que el checkout: neto del descuento, menos lo ya
  // pagado de comida (sin propinas).
  const paidFood = order.payments.reduce((s, p) => s + Math.max(0, p.amountCents - p.tipCents), 0);
  const outstandingCents = Math.max(0, order.subtotalCents + order.taxCents - order.discountCents - paidFood);
  const availability = manualInvoicePayLinkAvailability({
    tableKind: order.table.kind,
    orderStatus: order.status,
    outstandingCents,
    tenant: order.restaurant,
  });
  if (!availability.ok) return NextResponse.json({ error: availability.reason }, { status: 409 });

  const currency = await getCurrencyForCountry(order.restaurant.country);
  const link = await db.$transaction((tx) =>
    ensureManualInvoicePayLinkInTx(tx, {
      restaurantId: scope.restaurantId,
      orderId: order.id,
      amountCents: outstandingCents,
      currency,
    }),
  );
  const url = `${appOrigin(req)}${manualInvoicePayLinkPath(order.restaurant.slug, link.token)}`;

  if (link.rotated) {
    await recordAuditEvent({
      kind: "order.manual_invoice.pay_link.create",
      restaurantId: scope.restaurantId,
      target: { type: "order", id: order.id },
      summary: `Creó link de pago de la factura manual ${order.shortCode}`,
      diff: { after: { expiresAt: link.expiresAt.toISOString(), amountCents: outstandingCents } },
    });
  }

  let sentTo = link.payerEmail;
  let sentAt = link.emailSentAt;
  if (parsed.data.email) {
    const sent = await sendManualInvoicePayLinkEmail({
      to: parsed.data.email,
      locale: order.locale,
      restaurantName: order.restaurant.name,
      orderCode: order.shortCode,
      totalCents: outstandingCents,
      currency,
      lines: order.items.map((i) => ({ name: i.nameSnapshot, qty: i.qty, amountCents: i.priceCentsSnapshot * i.qty })),
      payUrl: url,
      expiresAt: link.expiresAt,
      customerName: order.invoiceRequests[0]?.customerName ?? null,
    });
    if (!sent) {
      return NextResponse.json(
        { error: "email_failed", url, expiresAt: link.expiresAt.toISOString(), sentTo, sentAt: sentAt?.toISOString() ?? null },
        { status: 502 },
      );
    }
    const now = new Date();
    await db.$transaction((tx) => recordManualInvoicePayLinkEmail(tx, link.id, parsed.data.email!, now));
    sentTo = parsed.data.email;
    sentAt = now;
    await recordAuditEvent({
      kind: "order.manual_invoice.pay_link.email",
      restaurantId: scope.restaurantId,
      target: { type: "order", id: order.id },
      summary: `Envió el link de pago de la factura manual ${order.shortCode} a ${parsed.data.email}`,
    });
  }

  return NextResponse.json({
    url,
    expiresAt: link.expiresAt.toISOString(),
    sentTo,
    sentAt: sentAt?.toISOString() ?? null,
    rotated: link.rotated,
  });
}

export const POST = secureApi(POSTHandler);
