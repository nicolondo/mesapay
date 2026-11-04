// Helper que arma el reporte contable de un turno cerrado. Lo
// consume /operator/shifts/[id] (vista web imprimible) y se podría
// reusar en futuras exportaciones (CSV, PDF, email al admin).
//
// Selecciona los pagos por pin o ventana personal y los agrega en JS.
// El INC usa una proyección fiscal por lotes de los pedidos seleccionados;
// incluye sus otros pagos liquidados para conservar el reparto histórico.

import type { PaymentMethod } from "@prisma/client";
import { db } from "./db";
import { cashCentsToNumber } from "./shiftCash";
import { isCashMethod, reportingPaymentMethod } from "@/lib/payments/methods";
import { loadShiftConsumptionTax, loadShiftPaymentSummaries } from "@/lib/reports/shiftConsumptionTaxQuery";
import { sumShiftConsumptionTax } from "@/lib/reports/shiftConsumptionTax";
import { loadTipReturns, sumTipReturnLines, tipReturnLines, type TipReturn, type TipReturnLine } from "@/lib/creditNoteTipReturns";

export type ShiftReport = {
  shift: {
    id: string;
    restaurantId: string;
    userId: string | null;
    userLabel: string | null; // "Juan Mesero" si es shift personal, null si es global
    openedAt: Date;
    businessDate: Date | null;
    closedAt: Date | null;
    openingCashCents: number;
    declaredCashCents: number | null;
    expectedCashCents: number | null;
    cashDiffCents: number | null;
    notes: string | null;
  };
  totals: {
    grossCents: number; // suma de amountCents de todos los pagos approved
    tipCents: number; // suma de tipCents (lo que se llevó como propina)
    // Propinas devueltas por notas de anulación emitidas durante el turno
    // («Propina devuelta por anulación (NC…)»). El turno de la cuenta
    // original no cambia: la devolución cae en el turno de la nota.
    tipReturns: TipReturnLine[];
    tipReturnedCents: number;
    tipNetCents: number; // tipCents − tipReturnedCents (puede ser negativo)
    foodCents: number; // gross - tip
    consumptionTaxCents: number; // frozen INC included in collected payments
    taxPendingPayments: number; // selected payments without a reliable invoice allocation
    paymentCount: number;
    ordersClosed: number; // distinct orderId
  };
  byMethod: Array<{
    method: PaymentMethod;
    isCash: boolean;
    count: number;
    grossCents: number;
    tipCents: number;
  }>;
  byWaiter: Array<{
    userId: string | null; // null = pagos donde no se trackeó quien cobró (cliente desde QR)
    userLabel: string;
    count: number;
    grossCents: number;
    tipCents: number;
    /** Su parte de las propinas devueltas por anulación en el turno. */
    tipReturnedCents: number;
    // Solo los pagos en efectivo cobrados por este mesero — útil
    // para arqueo personal cuando el shift es global pero se quiere
    // ver "cuánto efectivo entregó cada mesero".
    cashCents: number;
  }>;
  cash: {
    // Total recibido en efectivo durante el turno (sum amountCents
    // de los pagos approved en efectivo: cash o el histórico demo_cash).
    receivedCents: number;
    // Vuelto entregado durante el turno: para pagos con
    // cashTenderCents seteado, vuelto = tender - amount.
    changeGivenCents: number;
    // Tender bruto entregado por clientes (sum cashTenderCents).
    // Útil para conciliar con el cajón.
    tenderCents: number;
  };
  payments: Array<{
    id: string;
    settledAt: Date | null;
    orderId: string;
    orderShortCode: string;
    tableLabel: string | null;
    method: PaymentMethod;
    amountCents: number;
    tipCents: number;
    cashTenderCents: number | null;
    collectedByUserId: string | null;
    collectedByLabel: string | null;
  }>;
};

type WaiterRow = ShiftReport["byWaiter"][number];

/**
 * Filas por mesero con su parte de las propinas devueltas por anulación (la
 * que cobró). Un mesero que devolvió propina en el turno sin haber cobrado
 * nada en él aparece igual, con la devolución.
 */
function withWaiterTipReturns(
  rows: Map<string, WaiterRow>,
  returns: readonly TipReturn[],
  labels: ReadonlyMap<string, string>,
): WaiterRow[] {
  const out = new Map(rows);
  for (const r of returns) {
    for (const part of r.byCollector) {
      const key = part.userId ?? "__guest__";
      const row = out.get(key) ?? {
        userId: part.userId,
        userLabel: part.userId ? (labels.get(part.userId) ?? part.userId) : "Cobro directo del cliente",
        count: 0,
        grossCents: 0,
        tipCents: 0,
        tipReturnedCents: 0,
        cashCents: 0,
      };
      out.set(key, { ...row, tipReturnedCents: row.tipReturnedCents + part.cents });
    }
  }
  return [...out.values()];
}

export async function buildShiftReport(
  shiftId: string,
): Promise<ShiftReport | null> {
  const shift = await db.shift.findUnique({
    where: { id: shiftId },
    include: {
      // Quien era el dueño del turno si es personal (mesero).
      user: { select: { id: true, name: true, email: true } },
    },
  });
  if (!shift) return null;

  // Cómo se delimita el set de pagos del turno:
  //  - Turno GLOBAL del local (userId == null): los pagos quedan
  //    "pinneados" con shiftId al cerrar (lo hace el operador). El
  //    reporte sigue ese pin.
  //  - Turno PERSONAL de un mesero (userId != null): NO se pinnea
  //    shiftId — un mismo pago vive a la vez en el turno del local y
  //    en el del mesero, y shiftId es un solo FK (no puede apuntar a
  //    los dos a la vez). Para el reporte personal lo resolvemos como
  //    "lo que ESE mesero cobró dentro de su ventana de turno"
  //    (collectedByUserId + settledAt en [openedAt, closedAt]), igual
  //    que el resumen que ve el mesero al cerrar en su PWA. Sin esto el
  //    reporte personal salía en $0 porque no había ningún pago con su
  //    shiftId.
  const paymentWhere =
    shift.userId == null
      ? { shiftId: shift.id, status: "approved" as const, order: { restaurantId: shift.restaurantId } }
      : {
          order: { restaurantId: shift.restaurantId },
          collectedByUserId: shift.userId,
          status: "approved" as const,
          settledAt: {
            gte: shift.openedAt,
            ...(shift.closedAt ? { lte: shift.closedAt } : {}),
          },
        };
  const payments = await db.payment.findMany({
    where: paymentWhere,
    include: {
      order: {
        select: {
          id: true,
          shortCode: true,
          table: { select: { number: true, label: true, kind: true } },
        },
      },
      collectedBy: { select: { id: true, name: true, email: true } },
    },
    orderBy: { settledAt: "asc" },
  });
  const [consumptionTax, returns] = await Promise.all([
    loadShiftConsumptionTax(shift.restaurantId, payments),
    loadTipReturns(shift.restaurantId, { from: shift.openedAt, to: shift.closedAt }),
  ]);
  // Turno personal: sólo la parte de las propinas devueltas que le toca a
  // ese mesero (la que él cobró). Turno del local: todas.
  const returnLines = tipReturnLines(returns, shift.userId ?? undefined);
  const returnedCents = sumTipReturnLines(returnLines);

  // Totales generales.
  let grossCents = 0;
  let tipCents = 0;
  const orderIds = new Set<string>();
  for (const p of payments) {
    grossCents += p.amountCents;
    tipCents += p.tipCents;
    orderIds.add(p.orderId);
  }

  // Breakdown por método.
  const methodMap = new Map<
    PaymentMethod,
    {
      method: PaymentMethod;
      isCash: boolean;
      count: number;
      grossCents: number;
      tipCents: number;
    }
  >();
  for (const p of payments) {
    // cash y el histórico demo_cash comparten la fila "Efectivo".
    const method = reportingPaymentMethod(p.method);
    const entry = methodMap.get(method) ?? {
      method,
      isCash: isCashMethod(method),
      count: 0,
      grossCents: 0,
      tipCents: 0,
    };
    entry.count += 1;
    entry.grossCents += p.amountCents;
    entry.tipCents += p.tipCents;
    methodMap.set(method, entry);
  }

  // Breakdown por mesero (collectedByUserId).
  const waiterMap = new Map<
    string,
    {
      userId: string | null;
      userLabel: string;
      count: number;
      grossCents: number;
      tipCents: number;
      tipReturnedCents: number;
      cashCents: number;
    }
  >();
  for (const p of payments) {
    const key = p.collectedByUserId ?? "__guest__";
    const label = p.collectedBy
      ? p.collectedBy.name ?? p.collectedBy.email
      : "Cobro directo del cliente";
    const entry = waiterMap.get(key) ?? {
      userId: p.collectedByUserId,
      userLabel: label,
      count: 0,
      grossCents: 0,
      tipCents: 0,
      tipReturnedCents: 0,
      cashCents: 0,
    };
    entry.count += 1;
    entry.grossCents += p.amountCents;
    entry.tipCents += p.tipCents;
    if (isCashMethod(p.method)) entry.cashCents += p.amountCents;
    waiterMap.set(key, entry);
  }

  // Propinas devueltas por mesero (sólo en el turno del local): quien
  // devolvió sin haber cobrado en este turno también aparece, con su nombre.
  const waiterReturns = shift.userId == null ? returns : [];
  const missing = [
    ...new Set(
      waiterReturns.flatMap((r) => r.byCollector.map((c) => c.userId)).filter((id): id is string => !!id && !waiterMap.has(id)),
    ),
  ];
  const returnLabels = new Map(
    (missing.length
      ? await db.user.findMany({ where: { id: { in: missing } }, select: { id: true, name: true, email: true } })
      : []
    ).map((u) => [u.id, u.name ?? u.email]),
  );

  // Cash specifics.
  let cashReceived = 0;
  let cashTender = 0;
  let cashChange = 0;
  for (const p of payments) {
    if (!isCashMethod(p.method)) continue;
    cashReceived += p.amountCents;
    if (p.cashTenderCents != null && p.cashTenderCents > p.amountCents) {
      cashTender += p.cashTenderCents;
      cashChange += p.cashTenderCents - p.amountCents;
    } else {
      // Si no hay tender registrado, asumimos que el cliente pagó
      // justo (no hay vuelto). El tender bruto en ese caso lo
      // contamos igual al amount para que la suma "tender" tenga
      // sentido como total de billetes recibidos.
      cashTender += p.amountCents;
    }
  }

  const report: ShiftReport = {
    shift: {
      id: shift.id,
      restaurantId: shift.restaurantId,
      userId: shift.userId,
      userLabel: shift.user
        ? shift.user.name ?? shift.user.email
        : null,
      openedAt: shift.openedAt,
      businessDate: shift.businessDate,
      closedAt: shift.closedAt,
      openingCashCents: cashCentsToNumber(shift.openingCashCents),
      declaredCashCents: cashCentsToNumber(shift.declaredCashCents),
      expectedCashCents: cashCentsToNumber(shift.expectedCashCents),
      cashDiffCents: cashCentsToNumber(shift.cashDiffCents),
      notes: shift.notes,
    },
    totals: {
      grossCents,
      tipCents,
      tipReturns: returnLines,
      tipReturnedCents: returnedCents,
      tipNetCents: tipCents - returnedCents,
      foodCents: grossCents - tipCents,
      ...sumShiftConsumptionTax(consumptionTax, payments.map((p) => p.id)),
      paymentCount: payments.length,
      ordersClosed: orderIds.size,
    },
    byMethod: Array.from(methodMap.values()).sort(
      (a, b) => b.grossCents - a.grossCents,
    ),
    byWaiter: withWaiterTipReturns(waiterMap, waiterReturns, returnLabels).sort(
      (a, b) => b.grossCents - a.grossCents,
    ),
    cash: {
      receivedCents: cashReceived,
      changeGivenCents: cashChange,
      tenderCents: cashTender,
    },
    payments: payments.map((p) => ({
      id: p.id,
      settledAt: p.settledAt,
      orderId: p.orderId,
      orderShortCode: p.order.shortCode,
      tableLabel: p.order.table
        ? p.order.table.kind === "manual"
          ? p.order.table.label
          : `Mesa ${p.order.table.number}${p.order.table.label ? ` · ${p.order.table.label}` : ""}`
        : null,
      method: p.method,
      amountCents: p.amountCents,
      tipCents: p.tipCents,
      cashTenderCents: p.cashTenderCents,
      collectedByUserId: p.collectedByUserId,
      collectedByLabel: p.collectedBy
        ? p.collectedBy.name ?? p.collectedBy.email
        : null,
    })),
  };

  return report;
}

/**
 * Lista paginada de turnos cerrados para /operator/shifts. Incluye
 * Incluye ingresos, propinas e INC a través de consultas por lotes;
 * las ventanas personales no generan una consulta por cada turno.
 */
export async function listShiftsWithSummary(
  restaurantId: string,
  opts: { limit?: number; cursor?: string; userId?: string } = {},
) {
  const limit = Math.min(opts.limit ?? 30, 100);
  const shifts = await db.shift.findMany({
    where: {
      restaurantId,
      status: "closed",
      ...(opts.userId && { userId: opts.userId }),
    },
    orderBy: { closedAt: "desc" },
    take: limit + 1,
    ...(opts.cursor && {
      cursor: { id: opts.cursor },
      skip: 1,
    }),
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
  });

  const hasMore = shifts.length > limit;
  const slice = hasMore ? shifts.slice(0, limit) : shifts;

  const aggByShift = await loadShiftPaymentSummaries(restaurantId, slice);
  // Propinas devueltas por anulación: una sola consulta para toda la página,
  // repartida después por la ventana de cada turno.
  const returns = slice.length
    ? await loadTipReturns(restaurantId, {
        from: new Date(Math.min(...slice.map((s) => s.openedAt.getTime()))),
        to: new Date(Math.max(...slice.map((s) => (s.closedAt ?? new Date()).getTime()))),
      })
    : [];
  const returnedFor = (s: (typeof slice)[number]) =>
    sumTipReturnLines(
      tipReturnLines(
        returns.filter((r) => r.at >= s.openedAt && (!s.closedAt || r.at <= s.closedAt)),
        s.userId ?? undefined,
      ),
    );

  return {
    items: slice.map((s) => {
      const a = aggByShift.get(s.id);
      return {
        id: s.id,
        userId: s.userId,
        userLabel: s.user
          ? s.user.name ?? s.user.email
          : null,
        openedAt: s.openedAt,
        businessDate: s.businessDate,
        closedAt: s.closedAt,
        openingCashCents: cashCentsToNumber(s.openingCashCents),
        declaredCashCents: cashCentsToNumber(s.declaredCashCents),
        expectedCashCents: cashCentsToNumber(s.expectedCashCents),
        cashDiffCents: cashCentsToNumber(s.cashDiffCents),
        grossCents: a?.grossCents ?? 0,
        tipCents: a?.tipCents ?? 0,
        tipReturnedCents: returnedFor(s),
        paymentCount: a?.paymentCount ?? 0,
        consumptionTaxCents: a?.consumptionTaxCents ?? 0,
        taxPendingPayments: a?.taxPendingPayments ?? 0,
      };
    }),
    nextCursor: hasMore ? slice[slice.length - 1].id : null,
  };
}

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  demo_card: "Tarjeta (demo)",
  demo_cash: "Efectivo",
  cash: "Efectivo",
  wompi_card: "Tarjeta",
  wompi_pse: "PSE",
  wompi_nequi: "Nequi",
  kushki_apple_pay: "Apple Pay",
  kushki_google_pay: "Google Pay",
  kushki_card_terminal: "Datáfono (Kushki)",
  kushki_card: "Tarjeta directa",
  external_terminal: "Datáfono propio",
  kushki_pse: "PSE",
  reservation_deposit: "Abono de reserva",
  voucher: "Bono empresarial",
  customer_credit: "Crédito a cliente",
};
