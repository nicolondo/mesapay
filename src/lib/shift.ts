// Cierre de turno helpers.
//
// A Shift is the period from when the operator clicks "Abrir turno"
// (declaring the opening cash float) until they click "Cerrar turno"
// (declaring the physical cash counted). It pins approved payments to
// itself at close time so the historical Z-report stays consistent even
// if a payment is edited later.
//
// One restaurant has at most one open shift at a time. We enforce that
// via a unique partial index in code (Prisma doesn't model partial
// uniques) — see openShift().

import type { Payment, PaymentMethod } from "@prisma/client";
import { db } from "@/lib/db";
import { NOT_MANUAL_INVOICE } from "@/lib/manualInvoice";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";
import { shiftCashToNumbers, type CashShift } from "@/lib/shiftCash";
import { isCashMethod, reportingPaymentMethod } from "@/lib/payments/methods";
import { loadShiftConsumptionTax, loadShiftPaymentSummaries } from "@/lib/reports/shiftConsumptionTaxQuery";
import { sumShiftConsumptionTax, type ConsumptionTaxSummary } from "@/lib/reports/shiftConsumptionTax";
import { loadTipReturns, sumTipReturnLines, tipReturnLines, type TipReturnLine } from "@/lib/creditNoteTipReturns";

export type ShiftMethodBreakdown = {
  method: PaymentMethod;
  count: number;
  sumCents: number;
};

export type ShiftMetrics = ConsumptionTaxSummary & {
  payments: number;
  ordersClosed: number;
  grossCents: number;
  /** Propinas cobradas en el turno. */
  tipCents: number;
  /**
   * Propinas devueltas por notas de ANULACIÓN emitidas durante el turno
   * («Propina devuelta por anulación (NC…)»): ya no son del equipo.
   */
  tipReturns: TipReturnLine[];
  tipReturnedCents: number;
  /** Propinas del equipo: cobradas − devueltas. Puede quedar negativa (ver creditNoteTipReturns). */
  tipNetCents: number;
  cashCents: number;
  byMethod: ShiftMethodBreakdown[];
};

/** Suma al resumen del turno las propinas devueltas por anulación. */
function withTipReturns(metrics: ShiftMetrics, lines: TipReturnLine[]): ShiftMetrics {
  const returned = sumTipReturnLines(lines);
  return { ...metrics, tipReturns: lines, tipReturnedCents: returned, tipNetCents: metrics.tipCents - returned };
}

export async function getCurrentShift(restaurantId: string): Promise<CashShift | null> {
  // `userId: null` = SOLO el turno global del restaurante (el que abre/
  // cierra el operador). Sin este filtro, findFirst podía devolver el
  // turno PERSONAL de un mesero (Shift.userId != null, abierto desde su
  // PWA en shiftPolicy="by_waiter") por ser el más reciente — y entonces
  // el cierre del operador pinneaba TODOS los pagos del local a ese turno
  // personal, dejando un Z-report rotulado "Turno de Mesero X" pero con
  // cobros de todos los meseros. Los turnos personales se consultan
  // aparte con getCurrentMeseroShift(userId).
  const shift = await db.shift.findFirst({
    where: { restaurantId, status: "open", userId: null },
    orderBy: { openedAt: "desc" },
  });
  return shift ? shiftCashToNumbers(shift) : null;
}

export type RecentShift = CashShift & ConsumptionTaxSummary & {
  user: { name: string | null; email: string } | null;
};

export async function getRecentShifts(
  restaurantId: string,
  limit = 20,
): Promise<RecentShift[]> {
  // Cierres recientes del local: turnos GLOBALES (operador) Y PERSONALES
  // de mesero. Desde que el cierre de mesero hace arqueo (base/esperado/
  // contado/diferencia), ambos tienen datos que mostrar; `user` distingue
  // de quién es cada cierre (null = turno global del local).
  const shifts = await db.shift.findMany({
    where: { restaurantId, status: "closed" },
    orderBy: { closedAt: "desc" },
    take: limit,
    include: { user: { select: { name: true, email: true } } },
  });
  const summaries = await loadShiftPaymentSummaries(restaurantId, shifts);
  return shifts.map((shift) => ({
    ...shiftCashToNumbers(shift),
    consumptionTaxCents: summaries.get(shift.id)?.consumptionTaxCents ?? 0,
    taxPendingPayments: summaries.get(shift.id)?.taxPendingPayments ?? 0,
  }));
}

/**
 * Live metrics for the currently-open shift — looks at approved payments
 * that arrived since openedAt and aren't yet pinned to any shift.
 */
export async function computeOpenShiftMetrics(
  restaurantId: string,
  shift: Pick<CashShift, "openedAt">,
): Promise<ShiftMetrics> {
  const payments = await db.payment.findMany({
    where: {
      status: "approved",
      shiftId: null,
      createdAt: { gte: shift.openedAt },
      order: { restaurantId },
    },
    select: {
      id: true,
      method: true,
      amountCents: true,
      tipCents: true,
      orderId: true,
    },
  });
  const [tax, returns] = await Promise.all([
    loadShiftConsumptionTax(restaurantId, payments),
    loadTipReturns(restaurantId, { from: shift.openedAt, to: null }),
  ]);
  return withTipReturns(
    { ...rollUp(payments), ...sumShiftConsumptionTax(tax, payments.map((p) => p.id)) },
    tipReturnLines(returns),
  );
}

/** Same shape as live but for a closed shift, by following the shiftId pin. */
export async function computeClosedShiftMetrics(shiftId: string): Promise<ShiftMetrics> {
  const shift = await db.shift.findUnique({
    where: { id: shiftId },
    select: { restaurantId: true, openedAt: true, closedAt: true, userId: true },
  });
  if (!shift) return rollUp([]);
  const payments = await db.payment.findMany({
    where: { shiftId, status: "approved", order: { restaurantId: shift.restaurantId } },
    select: {
      id: true,
      method: true,
      amountCents: true,
      tipCents: true,
      orderId: true,
    },
  });
  const [tax, returns] = await Promise.all([
    loadShiftConsumptionTax(shift.restaurantId, payments),
    loadTipReturns(shift.restaurantId, { from: shift.openedAt, to: shift.closedAt }),
  ]);
  return withTipReturns(
    { ...rollUp(payments), ...sumShiftConsumptionTax(tax, payments.map((p) => p.id)) },
    tipReturnLines(returns, shift.userId ?? undefined),
  );
}

function rollUp(
  payments: Pick<Payment, "method" | "amountCents" | "tipCents" | "orderId">[],
): ShiftMetrics {
  const byMethod = new Map<PaymentMethod, { count: number; sumCents: number }>();
  const orderIds = new Set<string>();
  let gross = 0;
  let tips = 0;
  let cash = 0;
  for (const p of payments) {
    // El efectivo histórico (demo_cash) y el nuevo (cash) van en una sola
    // fila "Efectivo" del desglose.
    const method = reportingPaymentMethod(p.method);
    const row = byMethod.get(method) ?? { count: 0, sumCents: 0 };
    row.count += 1;
    row.sumCents += p.amountCents;
    byMethod.set(method, row);
    gross += p.amountCents;
    tips += p.tipCents;
    if (isCashMethod(p.method)) cash += p.amountCents;
    orderIds.add(p.orderId);
  }
  return {
    payments: payments.length,
    ordersClosed: orderIds.size,
    grossCents: gross,
    tipCents: tips,
    tipReturns: [],
    tipReturnedCents: 0,
    tipNetCents: tips,
    cashCents: cash,
    consumptionTaxCents: 0,
    taxPendingPayments: 0,
    byMethod: Array.from(byMethod.entries())
      .map(([method, agg]) => ({ method, count: agg.count, sumCents: agg.sumCents }))
      .sort((a, b) => b.sumCents - a.sumCents),
  };
}

/**
 * Orders that are still "alive" (not paid, not cancelled). Returned so the
 * close flow can list them as a hard block — closing a shift with cuentas
 * abiertas hides revenue.
 */
export async function listOpenOrders(restaurantId: string, since: Date) {
  const rows = await db.order.findMany({
    where: {
      restaurantId,
      status: { notIn: ["paid", "cancelled"] },
      // Una factura manual no es una cuenta del salón: no frena el cierre
      // (vive en Facturas manuales, puede seguir abierta días).
      ...NOT_MANUAL_INVOICE,
      // Las del turno… y toda cuenta FACTURADA sin cobrar, aunque venga de
      // un turno anterior: una factura emitida que nadie cobró (el cliente
      // se fue) no puede quedar olvidada en una mesa. Se cobra o se anula
      // con nota crédito; MESAPAY no la anula sola.
      OR: [{ createdAt: { gte: since } }, { simpleInvoice: { isNot: null } }],
    },
    select: {
      id: true,
      shortCode: true,
      subtotalCents: true,
      totalCents: true,
      status: true,
      createdAt: true,
      table: { select: { number: true, label: true } },
      // Factura emitida ANTES de cobrar: la cuenta está "facturada,
      // pendiente de pago" — se cobra, o se anula con nota crédito si el
      // cliente se fue. El cierre la nombra para que no pase de largo.
      simpleInvoice: { select: { invoiceNumber: true, snapshot: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(({ simpleInvoice, ...o }) => ({
    ...o,
    invoiceDocumentNumber: simpleInvoice
      ? formatInvoiceNumber(
          simpleInvoice.snapshot as unknown as InvoiceSnapshot,
          simpleInvoice.invoiceNumber,
        )
      : null,
  }));
}
