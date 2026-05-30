// Helper que arma el reporte contable de un turno cerrado. Lo
// consume /operator/shifts/[id] (vista web imprimible) y se podría
// reusar en futuras exportaciones (CSV, PDF, email al admin).
//
// Diseño: una sola query a Payment.findMany filtrada por shiftId,
// y luego agregamos en JS. El volumen por turno típico (50-300
// pagos) cabe holgado en memoria y evita 3-4 queries groupBy
// distintas. Si en algún momento un comercio cruza los 10k pagos
// por turno (raro — ni Starbucks Bogotá llega a eso), se puede
// migrar a groupBy.

import type { PaymentMethod } from "@prisma/client";
import { db } from "./db";

export type ShiftReport = {
  shift: {
    id: string;
    restaurantId: string;
    userId: string | null;
    userLabel: string | null; // "Juan Mesero" si es shift personal, null si es global
    openedAt: Date;
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
    foodCents: number; // gross - tip
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
    // Solo los pagos en efectivo cobrados por este mesero — útil
    // para arqueo personal cuando el shift es global pero se quiere
    // ver "cuánto efectivo entregó cada mesero".
    cashCents: number;
  }>;
  cash: {
    // Total recibido en efectivo durante el turno (sum amountCents
    // donde method=demo_cash + approved).
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

const CASH_METHODS: PaymentMethod[] = ["demo_cash"];

function isCashMethod(method: PaymentMethod): boolean {
  return CASH_METHODS.includes(method);
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

  // Pagos pinneados al shift al cerrar. Sólo approved cuentan para
  // el reporte (los declined/pending no entran).
  const payments = await db.payment.findMany({
    where: { shiftId: shift.id, status: "approved" },
    include: {
      order: {
        select: {
          id: true,
          shortCode: true,
          table: { select: { number: true, label: true } },
        },
      },
      collectedBy: { select: { id: true, name: true, email: true } },
    },
    orderBy: { settledAt: "asc" },
  });

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
    const entry = methodMap.get(p.method) ?? {
      method: p.method,
      isCash: isCashMethod(p.method),
      count: 0,
      grossCents: 0,
      tipCents: 0,
    };
    entry.count += 1;
    entry.grossCents += p.amountCents;
    entry.tipCents += p.tipCents;
    methodMap.set(p.method, entry);
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
      cashCents: 0,
    };
    entry.count += 1;
    entry.grossCents += p.amountCents;
    entry.tipCents += p.tipCents;
    if (isCashMethod(p.method)) entry.cashCents += p.amountCents;
    waiterMap.set(key, entry);
  }

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
      closedAt: shift.closedAt,
      openingCashCents: shift.openingCashCents,
      declaredCashCents: shift.declaredCashCents,
      expectedCashCents: shift.expectedCashCents,
      cashDiffCents: shift.cashDiffCents,
      notes: shift.notes,
    },
    totals: {
      grossCents,
      tipCents,
      foodCents: grossCents - tipCents,
      paymentCount: payments.length,
      ordersClosed: orderIds.size,
    },
    byMethod: Array.from(methodMap.values()).sort(
      (a, b) => b.grossCents - a.grossCents,
    ),
    byWaiter: Array.from(waiterMap.values()).sort(
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
        ? `Mesa ${p.order.table.number}${p.order.table.label ? ` · ${p.order.table.label}` : ""}`
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
 * el grossCents+tipCents+paymentCount precomputado por una query
 * Aggregate para no tener que cargar todos los pagos. Suficiente
 * para una tabla resumen — los detalles se ven al click.
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

  // Aggregate de pagos por shift en UNA sola query.
  const ids = slice.map((s) => s.id);
  const aggs = ids.length
    ? await db.payment.groupBy({
        by: ["shiftId"],
        where: { shiftId: { in: ids }, status: "approved" },
        _sum: { amountCents: true, tipCents: true },
        _count: { _all: true },
      })
    : [];
  const aggByShift = new Map(
    aggs.map((a) => [
      a.shiftId,
      {
        grossCents: a._sum.amountCents ?? 0,
        tipCents: a._sum.tipCents ?? 0,
        paymentCount: a._count._all,
      },
    ]),
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
        closedAt: s.closedAt,
        openingCashCents: s.openingCashCents,
        declaredCashCents: s.declaredCashCents,
        expectedCashCents: s.expectedCashCents,
        cashDiffCents: s.cashDiffCents,
        grossCents: a?.grossCents ?? 0,
        tipCents: a?.tipCents ?? 0,
        paymentCount: a?.paymentCount ?? 0,
      };
    }),
    nextCursor: hasMore ? slice[slice.length - 1].id : null,
  };
}

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  demo_card: "Tarjeta (demo)",
  demo_cash: "Efectivo",
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
};
