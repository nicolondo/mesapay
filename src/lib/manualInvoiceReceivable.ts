import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeCustomerDocument } from "@/lib/customerDocument";
import { loadCustomerCreditSummary } from "@/lib/customerCredit";
import { lockOrder } from "@/lib/orderLock";
import { recomputeOrderTotalsInTx } from "@/lib/orderTotals";
import { activateOpenRounds } from "@/lib/prepaidRounds";
import { findPaymentInFlight, releaseStaffPaymentRequests, staffOutstanding } from "@/lib/payments/staffCharge";
import {
  ensureManualInvoicePayLinkInTx,
  receivablePayLinkExpiry,
  receivablePayLinkState,
  type EnsuredPayLink,
  type PayLinkState,
} from "@/lib/manualInvoicePayLink";

/**
 * FACTURA MANUAL EMITIDA POR COBRAR — "Emitir y enviar factura".
 *
 * El dueño: «necesito que la factura pueda quedar emitida para después
 * mandar el link de pago y que no quede activa pendiente de pago en las
 * mesas». Es exactamente una VENTA A CRÉDITO al cliente de la factura, y
 * eso ya existe (src/lib/customerCredit.ts):
 *
 *   1. El cliente de la factura (la solicitud de factura de la cuenta) se
 *      busca —o se crea— como cliente de facturación (`BillingCustomer`),
 *      SIN prenderle el crédito: el crédito del comercio es para fiar en
 *      la mesa; acá la venta ya está pactada y la factura emitida.
 *   2. La cuenta se cierra con un `Payment` `customer_credit` aprobado por
 *      todo el saldo: queda `paid` para Mesas, Salón, el datáfono y los
 *      contadores, y la deuda pasa a Cartera (cuentas por cobrar).
 *   3. La factura sale por el riel de siempre (`issueInvoiceOnPaid`): con
 *      facturación electrónica, a la DIAN con forma de pago CRÉDITO y
 *      vencimiento = emisión + plazo del cliente; sin ella, el comprobante.
 *      Si ya estaba emitida antes de cobrar (#577) no se emite otra.
 *   4. El link de pago de la cuenta (el mismo, uno por orden) pasa a cobrar
 *      ESE cargo (`PaymentLink.creditPaymentId`). Pagado en línea, deja un
 *      abono DIRIGIDO al cargo (`paymentLinks.applyPaidEffect`).
 *
 * Contabilidad (motor diario, src/lib/erp/posting.ts) — nada se duplica:
 *   · al emitir: "Ventas del día" D 130505 Clientes · C ingresos + impuesto
 *     (el cargo a crédito es el pago de la orden; el impuesto es el de la
 *     factura, una sola vez);
 *   · al pagar: "Abonos de clientes" D 112005 pasarela (o la cuenta que se
 *     elija al registrarlo desde Cartera) · C 130505. El abono NO es un
 *     pago de la orden: no vuelve a contar venta ni impuesto.
 *
 * Pago parcial: el link cobra el SALDO del cargo completo; si se registra
 * un abono parcial desde Cartera, el link pasa a cobrar lo que falte.
 */

export type IssueReceivableError =
  | "not_found"
  | "not_manual_invoice"
  | "order_closed"
  | "nothing_to_pay"
  | "customer_required"
  | "customer_invalid"
  | "pending_payment_in_flight";

export type IssuedReceivable = {
  ok: true;
  orderId: string;
  paymentId: string;
  billingCustomerId: string;
  /** Lo que quedó por cobrar (el cargo a crédito). */
  amountCents: number;
  dueDate: Date;
  link: EnsuredPayLink;
};

/**
 * El cliente de facturación de la solicitud de factura: el que ya existe
 * con ese documento (normalizado como lo guarda el alta de clientes) o uno
 * nuevo con los datos de la solicitud. Nunca le cambia nada a uno que ya
 * existe (ni el correo ni el crédito).
 */
export async function findOrCreateInvoiceCustomer(
  restaurantId: string,
  request: { customerName: string; docType: "CC" | "CE" | "NIT" | "PA"; docNumber: string; email: string },
): Promise<{ id: string; creditTermsDays: number } | null> {
  const document = normalizeCustomerDocument(request.docType, request.docNumber);
  if (!document.ok) return null;
  const where = {
    restaurantId_docType_docNumber: { restaurantId, docType: request.docType, docNumber: document.docNumber },
  };
  const existing = await db.billingCustomer.findUnique({ where, select: { id: true, creditTermsDays: true } });
  if (existing) return existing;
  try {
    return await db.billingCustomer.create({
      data: {
        restaurantId,
        customerName: request.customerName.trim().slice(0, 160),
        docType: request.docType,
        docNumber: document.docNumber,
        verificationDigit: document.verificationDigit,
        email: request.email.trim().toLowerCase(),
      },
      select: { id: true, creditTermsDays: true },
    });
  } catch (err) {
    // Dos emisiones a la vez con el mismo cliente nuevo: gana una.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return db.billingCustomer.findUnique({ where, select: { id: true, creditTermsDays: true } });
    }
    throw err;
  }
}

/**
 * Cierra la factura manual a crédito del cliente de su factura y deja el
 * link de pago cobrando ese cargo. NO emite la factura ni manda correos:
 * eso lo hace quien llama, fuera de la transacción (`issueInvoiceOnPaid`).
 */
export async function issueManualInvoiceReceivable(args: {
  restaurantId: string;
  orderId: string;
  userId: string | null;
  currency: string;
  now?: Date;
}): Promise<IssuedReceivable | { ok: false; error: IssueReceivableError }> {
  const now = args.now ?? new Date();
  const order = await db.order.findFirst({
    where: { id: args.orderId, restaurantId: args.restaurantId },
    select: { id: true, status: true, table: { select: { kind: true } } },
  });
  if (!order) return { ok: false, error: "not_found" };
  if (order.table.kind !== "manual") return { ok: false, error: "not_manual_invoice" };
  if (order.status === "paid" || order.status === "cancelled") return { ok: false, error: "order_closed" };

  // La factura sale a nombre del cliente identificado en la cuenta; sin él
  // no hay a quién cobrarle (una factura a consumidor final no es cartera).
  const request = await db.invoiceRequest.findFirst({
    where: { orderId: order.id, status: "pending" },
    orderBy: { createdAt: "desc" },
    select: { customerName: true, docType: true, docNumber: true, email: true },
  });
  if (!request) return { ok: false, error: "customer_required" };
  const customer = await findOrCreateInvoiceCustomer(args.restaurantId, request);
  if (!customer) return { ok: false, error: "customer_invalid" };
  const dueDate = new Date(now.getTime() + customer.creditTermsDays * 24 * 3600_000);

  type TxResult =
    | { error: IssueReceivableError }
    | { paymentId: string; amountCents: number; link: EnsuredPayLink };
  const result = await db.$transaction(async (tx): Promise<TxResult> => {
    await lockOrder(tx, order.id);
    const current = await tx.order.findUnique({ where: { id: order.id }, select: { status: true } });
    if (!current || current.status === "paid" || current.status === "cancelled") return { error: "order_closed" };
    // Un pago en línea en curso (el cliente pagando con el link abierto, un
    // PSE sin respuesta): no se cierra la cuenta encima de él.
    if (await findPaymentInFlight(tx, order.id)) return { error: "pending_payment_in_flight" };
    const { outstandingCents } = await staffOutstanding(tx, order.id);
    if (outstandingCents <= 0) return { error: "nothing_to_pay" };
    // Solicitudes del comensal (efectivo, datáfono sin enviar): este cierre
    // las reemplaza, como cualquier cobro del staff.
    await releaseStaffPaymentRequests(tx, order.id);
    const payment = await tx.payment.create({
      data: {
        orderId: order.id,
        method: "customer_credit",
        status: "approved",
        amountCents: outstandingCents,
        tipCents: 0,
        billingCustomerId: customer.id,
        collectedByUserId: args.userId,
        settledAt: now,
      },
      select: { id: true },
    });
    const totals = await recomputeOrderTotalsInTx(tx, order.id);
    if (!totals.fullyPaid) throw new Error("receivable_not_closed");
    // Una factura manual no tiene rondas prepagas, pero el cierre es el de
    // cualquier cobro: si las hubiera, salen ahora (como settle-credit).
    await activateOpenRounds(tx, order.id);
    const link = await ensureManualInvoicePayLinkInTx(tx, {
      restaurantId: args.restaurantId,
      orderId: order.id,
      amountCents: outstandingCents,
      currency: args.currency,
      now,
      creditPaymentId: payment.id,
      expiresAt: receivablePayLinkExpiry(now, customer.creditTermsDays),
    });
    return { paymentId: payment.id, amountCents: outstandingCents, link };
  });
  if ("error" in result) return { ok: false, error: result.error };
  return {
    ok: true,
    orderId: order.id,
    paymentId: result.paymentId,
    billingCustomerId: customer.id,
    amountCents: result.amountCents,
    dueDate,
    link: result.link,
  };
}

export type ReceivableCharge = {
  paymentId: string;
  billingCustomerId: string;
  /** Lo que el cargo pesa hoy (sin lo devuelto ni lo anulado por notas crédito). */
  totalCents: number;
  /** Lo que falta por cobrar de ESE cargo (abonos dirigidos y FIFO). */
  outstandingCents: number;
  /** Vencimiento: fecha del cargo + plazo del cliente. */
  dueDate: Date;
};

/** Saldo vivo del cargo a crédito de una factura emitida por cobrar. */
export async function loadReceivableCharge(
  restaurantId: string,
  creditPaymentId: string,
  client: Prisma.TransactionClient | typeof db = db,
): Promise<ReceivableCharge | null> {
  const payment = await client.payment.findUnique({
    where: { id: creditPaymentId },
    select: { billingCustomerId: true, settledAt: true, createdAt: true, order: { select: { restaurantId: true } } },
  });
  if (!payment?.billingCustomerId || payment.order.restaurantId !== restaurantId) return null;
  const summary = await loadCustomerCreditSummary(restaurantId, payment.billingCustomerId, client);
  if (!summary) return null;
  const fifo = summary.fifo.charges.find((c) => c.chargeId === creditPaymentId);
  const date = payment.settledAt ?? payment.createdAt;
  return {
    paymentId: creditPaymentId,
    billingCustomerId: payment.billingCustomerId,
    totalCents: fifo?.totalCents ?? 0,
    outstandingCents: fifo?.outstandingCents ?? 0,
    dueDate: new Date(date.getTime() + summary.customer.creditTermsDays * 24 * 3600_000),
  };
}

/**
 * Pone al día el monto del link de una factura por cobrar con el saldo
 * vivo de su cargo (un abono parcial registrado desde Cartera, una nota
 * crédito) y devuelve su estado. NO cambia `status`: el link sólo pasa a
 * `paid` cuando lo liquida un cobro en línea — si se marcara pagado por un
 * abono de Cartera, un cobro con tarjeta que llegue en la misma ventana se
 * quedaría sin registrar.
 */
export async function refreshReceivablePayLink(link: {
  id: string;
  restaurantId: string;
  status: string;
  expiresAt: Date | null;
  amountCents: number;
  creditPaymentId: string | null;
}): Promise<{ state: PayLinkState; charge: ReceivableCharge | null; amountCents: number }> {
  if (!link.creditPaymentId) return { state: "cancelled", charge: null, amountCents: link.amountCents };
  const charge = await loadReceivableCharge(link.restaurantId, link.creditPaymentId);
  if (!charge) return { state: "cancelled", charge: null, amountCents: link.amountCents };
  const state = receivablePayLinkState(link, charge);
  let amountCents = link.amountCents;
  if (state === "open" && charge.outstandingCents !== link.amountCents) {
    const updated = await db.paymentLink.updateMany({
      where: { id: link.id, status: "pending" },
      data: { amountCents: charge.outstandingCents },
    });
    if (updated.count > 0) amountCents = charge.outstandingCents;
  }
  return { state, charge, amountCents };
}

/**
 * El cliente abrió el link (en un navegador: lo marca la página al
 * cargar, no el redirect, que también lo recorren los antivirus de correo).
 * Sólo la primera vez.
 */
export async function markPayLinkOpened(where: { orderId: string } | { token: string }, now: Date = new Date()): Promise<boolean> {
  const res = await db.paymentLink.updateMany({
    where: { ...where, kind: "order", openedAt: null },
    data: { openedAt: now },
  });
  return res.count > 0;
}

/**
 * ¿La cuenta es una factura manual? Quien la paga sin ser del staff llegó
 * por su link: es un pagador REMOTO y sólo paga en línea. Las rutas de
 * efectivo y datáfono (presenciales) lo rechazan con `online_only` — el
 * checkout del link ni siquiera los muestra.
 */
export async function isManualInvoiceTable(tableId: string | null): Promise<boolean> {
  if (!tableId) return false;
  const table = await db.table.findUnique({ where: { id: tableId }, select: { kind: true } });
  return table?.kind === "manual";
}
