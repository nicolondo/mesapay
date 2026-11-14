import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Crédito a clientes de facturación.
 *
 * Una cuenta cobrada "a crédito" queda pagada para la mesa y la cocina,
 * pero no entra plata: el `Payment` (method = customer_credit, approved)
 * lleva `billingCustomerId` y representa lo que ese cliente DEBE. La deuda
 * se cancela con abonos (`CustomerCreditPayment`), que no se ligan a un
 * cobro puntual: se aplican FIFO al cargo más viejo (`allocateFifo`) para
 * las edades de cartera.
 *
 *   deuda = Σ cargos (monto con propina − reembolsado − notas crédito) − Σ abonos
 *
 * Una nota crédito aceptada por la DIAN sobre la factura de una cuenta a
 * crédito baja el cargo (`Payment.creditNoteCents`) hasta su saldo
 * pendiente: lo fija la contabilización de la nota
 * (`erp/creditNoteAccounting.stampCreditNoteAccounting`).
 *
 * Lo puro va arriba (tests sin DB); lo que toca Prisma, abajo.
 */

/** Un cobro a crédito, tal como lo dejó la ruta de cobro. */
export type CreditCharge = {
  id: string;
  /** Fecha del cobro (settledAt, o createdAt si faltara). */
  date: Date;
  /** Monto total del pago, propina incluida. */
  amountCents: number;
  tipCents: number;
  refundedCents: number;
  /** Parte cancelada por notas crédito aceptadas (0 si no hay). */
  creditNoteCents?: number;
};

/** Un abono del cliente a su deuda. */
export type CreditAbono = {
  id: string;
  date: Date;
  amountCents: number;
  /**
   * Cargo al que va dirigido (el pago por link de una factura manual, o el
   * "registrar pago" de su ficha). Se aplica a ése ANTES que el FIFO; lo
   * que sobre (pagó de más sobre ese cargo) sigue FIFO. null/ausente =
   * abono general.
   */
  chargeId?: string | null;
};

export type CreditCustomer = {
  creditEnabled: boolean;
  /** null = sin tope. */
  creditLimitCents: number | null;
};

export type CreditCheck =
  | { ok: true }
  | {
      ok: false;
      error: "credit_disabled" | "credit_limit_exceeded";
      /** Cuánto le queda de cupo (sólo con tope). */
      availableCents?: number;
    };

/**
 * Lo que un cargo todavía pesa en la deuda: monto (con propina) menos lo
 * devuelto y lo cancelado por notas crédito.
 */
export function chargeDebtCents(
  c: Pick<CreditCharge, "amountCents" | "refundedCents" | "creditNoteCents">,
): number {
  return Math.max(0, c.amountCents - c.refundedCents - (c.creditNoteCents ?? 0));
}

/** Deuda del cliente: Σ cargos vigentes − Σ abonos. Negativo = pagó de más. */
export function customerDebt(
  charges: readonly Pick<CreditCharge, "amountCents" | "refundedCents" | "creditNoteCents">[],
  payments: readonly Pick<CreditAbono, "amountCents">[],
): number {
  const charged = charges.reduce((s, c) => s + chargeDebtCents(c), 0);
  const paid = payments.reduce((s, p) => s + p.amountCents, 0);
  return charged - paid;
}

export type FifoCharge = {
  chargeId: string;
  totalCents: number;
  paidCents: number;
  outstandingCents: number;
};

export type FifoAllocation = {
  paymentId: string;
  chargeId: string;
  cents: number;
};

export type FifoResult = {
  /** En el mismo orden cronológico en que se consumieron. */
  charges: FifoCharge[];
  /** Qué parte de cada abono fue a cada cargo. */
  allocations: FifoAllocation[];
  /** Abonos que no encontraron cargo (pagó de más). */
  unappliedCents: number;
};

function byDateThenId<T extends { date: Date; id: string }>(a: T, b: T): number {
  return a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id);
}

/**
 * Aplica los abonos al cargo más viejo primero. Cada abono, en orden
 * cronológico, consume los cargos (también cronológicos) hasta agotarse;
 * el saldo por cargo es lo que alimenta las edades de cartera. Un abono
 * mayor que la deuda deja `unappliedCents`.
 *
 * Los abonos DIRIGIDOS (`chargeId`) van primero a su cargo: el link de
 * pago de una factura manual salda ESA factura aunque el cliente deba
 * otras más viejas. Lo que exceda el saldo de su cargo sigue el FIFO como
 * un abono general.
 */
export function allocateFifo(
  charges: readonly CreditCharge[],
  payments: readonly CreditAbono[],
): FifoResult {
  const sortedCharges = [...charges].sort(byDateThenId);
  const sortedPayments = [...payments].sort(byDateThenId);
  const result: FifoCharge[] = sortedCharges.map((c) => {
    const total = chargeDebtCents(c);
    return { chargeId: c.id, totalCents: total, paidCents: 0, outstandingCents: total };
  });
  const allocations: FifoAllocation[] = [];
  const byId = new Map(result.map((c) => [c.chargeId, c]));
  // 1) Dirigidos: cada uno a su cargo, hasta el saldo de ese cargo.
  const leftover = new Map<string, number>();
  for (const p of sortedPayments) {
    const target = p.chargeId ? byId.get(p.chargeId) : undefined;
    if (!target) continue;
    const take = Math.min(p.amountCents, target.outstandingCents);
    if (take > 0) {
      target.paidCents += take;
      target.outstandingCents -= take;
      allocations.push({ paymentId: p.id, chargeId: target.chargeId, cents: take });
    }
    leftover.set(p.id, p.amountCents - take);
  }
  // 2) Generales (y el sobrante de los dirigidos): FIFO.
  let unappliedCents = 0;
  let cursor = 0;
  for (const p of sortedPayments) {
    let left = leftover.get(p.id) ?? p.amountCents;
    while (left > 0 && cursor < result.length) {
      const c = result[cursor];
      if (c.outstandingCents <= 0) {
        cursor += 1;
        continue;
      }
      const take = Math.min(left, c.outstandingCents);
      c.paidCents += take;
      c.outstandingCents -= take;
      allocations.push({ paymentId: p.id, chargeId: c.chargeId, cents: take });
      left -= take;
      if (c.outstandingCents === 0) cursor += 1;
    }
    unappliedCents += left;
  }
  return { charges: result, allocations, unappliedCents };
}

/** ¿Se le puede cargar `amountCents` más a este cliente? */
export function canChargeOnCredit(args: {
  customer: CreditCustomer;
  debtCents: number;
  amountCents: number;
}): CreditCheck {
  if (!args.customer.creditEnabled) return { ok: false, error: "credit_disabled" };
  const limit = args.customer.creditLimitCents;
  if (limit != null && args.debtCents + args.amountCents > limit) {
    return {
      ok: false,
      error: "credit_limit_exceeded",
      availableCents: Math.max(0, limit - args.debtCents),
    };
  }
  return { ok: true };
}

// ─── DB ──────────────────────────────────────────────────────────────────

type Client = Prisma.TransactionClient | typeof db;

/**
 * Estados que siguen pesando en la deuda. Un cargo devuelto en su
 * totalidad pasa a `refunded` con refundedCents = amountCents y pesa 0:
 * se incluye para que la historia del cliente no pierda la fila.
 */
const CHARGE_STATUSES = ["approved", "refunded"] as const;

export type CreditChargeRow = CreditCharge & {
  orderId: string;
  orderShortCode: string;
  tableLabel: string | null;
};

export type CreditAbonoRow = CreditAbono & {
  accountCode: string;
  note: string | null;
  createdByName: string | null;
  /** Lo dejó el pago en línea de un link (no lo registró nadie del staff). */
  viaPayLink: boolean;
};

export type CustomerCreditSummary = {
  customer: CreditCustomer & { id: string; creditTermsDays: number };
  charges: CreditChargeRow[];
  payments: CreditAbonoRow[];
  debtCents: number;
  fifo: FifoResult;
};

/**
 * Historia completa de crédito de un cliente del comercio: cargos, abonos,
 * deuda y aplicación FIFO. `null` si el cliente no es de este comercio.
 * Acepta la transacción del cobro para leer la deuda bajo el lock.
 */
export async function loadCustomerCreditSummary(
  restaurantId: string,
  billingCustomerId: string,
  client: Client = db,
): Promise<CustomerCreditSummary | null> {
  const customer = await client.billingCustomer.findFirst({
    where: { id: billingCustomerId, restaurantId },
    select: { id: true, creditEnabled: true, creditLimitCents: true, creditTermsDays: true },
  });
  if (!customer) return null;
  const [chargeRows, abonoRows] = await Promise.all([
    client.payment.findMany({
      where: {
        billingCustomerId,
        method: "customer_credit",
        status: { in: [...CHARGE_STATUSES] },
        order: { restaurantId },
      },
      select: {
        id: true,
        settledAt: true,
        createdAt: true,
        amountCents: true,
        tipCents: true,
        refundedCents: true,
        creditNoteCents: true,
        orderId: true,
        order: { select: { shortCode: true, table: { select: { label: true, number: true } } } },
      },
      orderBy: [{ settledAt: "asc" }, { createdAt: "asc" }],
    }),
    client.customerCreditPayment.findMany({
      where: { billingCustomerId, restaurantId },
      select: {
        id: true,
        paidAt: true,
        amountCents: true,
        accountCode: true,
        note: true,
        creditChargeId: true,
        paymentLinkId: true,
        createdBy: { select: { name: true, email: true } },
      },
      orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }],
    }),
  ]);
  const charges: CreditChargeRow[] = chargeRows.map((p) => ({
    id: p.id,
    date: p.settledAt ?? p.createdAt,
    amountCents: p.amountCents,
    tipCents: p.tipCents,
    refundedCents: p.refundedCents,
    creditNoteCents: p.creditNoteCents,
    orderId: p.orderId,
    orderShortCode: p.order.shortCode,
    tableLabel: p.order.table ? p.order.table.label || String(p.order.table.number) : null,
  }));
  const payments: CreditAbonoRow[] = abonoRows.map((a) => ({
    id: a.id,
    date: a.paidAt,
    amountCents: a.amountCents,
    chargeId: a.creditChargeId,
    accountCode: a.accountCode,
    note: a.note,
    createdByName: a.createdBy ? a.createdBy.name ?? a.createdBy.email : null,
    viaPayLink: a.paymentLinkId != null,
  }));
  return {
    customer,
    charges,
    payments,
    debtCents: customerDebt(charges, payments),
    fifo: allocateFifo(charges, payments),
  };
}

// La deuda de MUCHOS clientes a la vez (listado y buscador) la calcula la
// consulta de `billingCustomerListQueries.ts`, en la base y con la misma
// fórmula, junto con la deuda vencida.
