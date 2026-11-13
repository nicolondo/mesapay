import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isReplaceablePending } from "@/lib/payments/methods";
import { terminalClaims } from "@/lib/payments/pendingRequests";
import { breBPendingViews } from "@/lib/payments/breB/service";
import { toTerminalAttemptView } from "@/lib/payments/terminalAttempt";
import {
  ORDER_INVOICE_VIEW_SELECT,
  orderInvoiceViewOf,
  type OrderInvoiceView,
} from "@/lib/orders/invoicedOrder";
import type { InvoiceIntent } from "@/components/invoice/types";
import {
  isSimpleInvoiceRequested,
  simpleInvoiceEmailFrom,
} from "@/lib/simpleInvoiceRequest";
import { SEND_INFO_LINK_SELECT } from "@/lib/manualInvoiceSendInfo";
import type { ActiveOrder } from "./MesasGrid";

/**
 * Una CUENTA VIVA tal como la pinta la ficha (`TableDetailSheet`): la de una
 * mesa en Mesas y la de una factura manual en Facturas manuales. Es lo que
 * antes armaba /operator/tables por dentro; vive acá para que las dos
 * pantallas lean exactamente lo mismo.
 */
export const ACTIVE_ORDER_INCLUDE = {
  items: {
    where: {
      cancelledAt: null,
      OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
    },
  },
  rounds: {
    where: { status: { not: "cancelled" } },
    orderBy: { seq: "asc" },
    include: {
      items: {
        where: { cancelledAt: null },
        orderBy: { id: "asc" },
      },
    },
  },
  // Necesitamos TODOS los payments (no sólo approved) para
  // calcular walkout-risk: los pending entran en Señal 1, los
  // approved alimentan el lastApprovedPaymentAt que resetea
  // el reloj de Señal 2.
  payments: {
    orderBy: { createdAt: "asc" },
  },
  // Comensal identificado en la cuenta — para mostrar quién es y
  // su descuento en el detalle de la mesa.
  diner: {
    select: { id: true, name: true, email: true, cedula: true },
  },
  // Cliente de la factura (solicitud pendiente): en una factura
  // manual es lo que el operador identifica desde la ficha.
  invoiceRequests: {
    where: { status: "pending" },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      status: true,
      customerName: true,
      docType: true,
      docNumber: true,
      email: true,
    },
  },
  // Factura emitida ANTES de cobrar: la ficha muestra "Facturada ·
  // pendiente de pago" y deja la cuenta cerrada a cambios.
  simpleInvoice: { select: ORDER_INVOICE_VIEW_SELECT },
  // Link de pago de una factura manual (enviado, abierto, vencido).
  payLink: { select: SEND_INFO_LINK_SELECT },
} satisfies Prisma.OrderInclude;

export type ActiveOrderRow = Prisma.OrderGetPayload<{ include: typeof ACTIVE_ORDER_INCLUDE }>;

export type ActiveOrderContext = {
  terminalClaimed: Awaited<ReturnType<typeof terminalClaims>>;
  breBPending: Awaited<ReturnType<typeof breBPendingViews>>;
  invoiceViews: Map<string, OrderInvoiceView>;
};

/** Lo que se carga aparte para varias cuentas de una vez. */
export async function loadActiveOrderContext(orders: readonly ActiveOrderRow[]): Promise<ActiveOrderContext> {
  const pending = orders.flatMap((o) => o.payments.filter((p) => p.status === "pending"));
  // Datáfonos Kushki pendientes que YA se enviaron al equipo (reclamo
  // `terminal:<id>`): la ficha los muestra como cobro en curso; los que no,
  // como solicitud que se puede cancelar. Una sola consulta para todas.
  const terminalClaimed = await terminalClaims(db, pending);
  // Bre-B en curso: en qué va su QR (vigente / sin confirmar), para que la
  // ficha ofrezca «Ver código», «Consultar estado» y «Cancelar cobro».
  const breBPending = await breBPendingViews(db, pending);
  // Facturas emitidas antes de cobrar (raras: se cargan aparte, con su
  // estado DIAN y si una nota crédito ya las anuló).
  const invoiceViews = new Map<string, OrderInvoiceView>();
  await Promise.all(
    orders
      .filter((o) => o.simpleInvoice)
      .map(async (o) => {
        const view = await orderInvoiceViewOf(db, o.simpleInvoice);
        if (view) invoiceViews.set(o.id, view);
      }),
  );
  return { terminalClaimed, breBPending, invoiceViews };
}

/**
 * Lo que la ficha necesita de una cuenta viva: cobrable neto del descuento,
 * lo que falta por cobrar, y el resumen de rondas/cliente.
 */
export function summarizeActiveOrder(order: ActiveOrderRow, ctx: ActiveOrderContext) {
  const approved = order.payments.filter((p) => p.status === "approved");
  const foodPaid = approved.reduce(
    (s, p) => s + p.amountCents - p.tipCents,
    0,
  );
  // El descuento del comensal identificado baja lo que falta por
  // cobrar. Sin restarlo acá, el mesero vería un pendiente mayor al
  // real y el cobro se rechazaría por "excede lo pendiente".
  const chargeableCents = Math.max(
    0,
    order.subtotalCents - order.discountCents,
  );
  const outstandingCents = Math.max(0, chargeableCents - foodPaid);
  const itemCount = order.items.reduce((s, i) => s + i.qty, 0);
  const activeOrder: ActiveOrder = {
    id: order.id,
    shortCode: order.shortCode,
    status: order.status,
    itemCount,
    subtotalCents: chargeableCents,
    grossSubtotalCents: order.subtotalCents,
    discountCents: order.discountCents,
    discountPct: order.discountPct,
    customer: order.diner
      ? {
          id: order.diner.id,
          name: order.diner.name,
          email: order.diner.email,
          cedula: order.diner.cedula,
        }
      : null,
    invoiceRequest: order.invoiceRequests[0] ?? null,
    // Lo que ya se pidió de factura en la cuenta (la hoja de "Imprimir
    // factura" lo muestra y deja cambiarlo) y la factura, si ya existe.
    invoiceIntent: (order.invoiceRequests[0]
      ? { kind: "formal", summary: order.invoiceRequests[0] }
      : isSimpleInvoiceRequested(order.simpleInvoiceEmail)
        ? { kind: "simple", email: simpleInvoiceEmailFrom(order.simpleInvoiceEmail) }
        : null) satisfies InvoiceIntent | null,
    invoice: ctx.invoiceViews.get(order.id) ?? null,
    outstandingCents,
    needsWaiter: order.needsWaiter,
    // Lo que el comensal pidió para pagar (efectivo, datáfono del
    // comercio) o un pago en línea en curso: la ficha lo muestra arriba.
    pendingPayments: order.payments
      .filter((p) => p.status === "pending")
      .map((p) => ({
        id: p.id,
        method: p.method,
        amountCents: p.amountCents,
        tipCents: p.tipCents,
        cashTenderCents: p.cashTenderCents,
        createdAt: p.createdAt.toISOString(),
        replaceable: isReplaceablePending(p, ctx.terminalClaimed.has(p.id)),
        reconciliationRequired: p.reconciliationRequired,
        pushedAt: ctx.terminalClaimed.get(p.id)?.createdAt.toISOString() ?? null,
        terminalAttempt: toTerminalAttemptView(ctx.terminalClaimed.get(p.id), p.reconciliationRequired),
        breB: ctx.breBPending.get(p.id) ?? null,
      })),
    rounds: order.rounds.map((r) => ({
      id: r.id,
      seq: r.seq,
      status: r.status,
      placedAt: r.placedAt.toISOString(),
      placedByName: r.placedByName,
      placedByRole: r.placedByRole,
      items: r.items.map((i) => ({
        id: i.id,
        menuItemId: i.menuItemId,
        name: i.nameSnapshot,
        qty: i.qty,
        priceCents: i.priceCentsSnapshot,
        kitchenStatus: i.kitchenStatus,
        preparationStartedAt: i.preparationStartedAt
          ? i.preparationStartedAt.toISOString()
          : null,
        preparationFirstStartedAt: i.preparationFirstStartedAt?.toISOString() ?? null,
        servedAt: i.servedAt ? i.servedAt.toISOString() : null,
        expediteRequestedAt: i.expediteRequestedAt
          ? i.expediteRequestedAt.toISOString()
          : null,
        guestName: i.guestName ?? null,
        notes: i.notes ?? null,
      })),
    })),
  };
  return { activeOrder, approved, outstandingCents };
}
