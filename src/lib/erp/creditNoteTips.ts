// Propina devuelta con la nota crédito de ANULACIÓN — lógica PURA (sin DB).
//
// La propina no va en la factura electrónica: el XML aceptado (y por lo
// tanto la nota crédito, que sale de ese XML) sólo trae la comida y sus
// impuestos. Pero el cliente sí la pagó. Regla del dueño (2026-11-04):
//
//   · Toda nota de ANULACIÓN (motivo DIAN "2", que siempre cubre la factura
//     entera) le devuelve también la propina de la cuenta, automáticamente.
//   · La nota electrónica NO cambia: XML, CUDE, totales fiscales y
//     representación gráfica siguen siendo los de la comida.
//   · Las notas parciales (otros motivos) no tocan la propina.
//
// DE DÓNDE SALE LA PROPINA («la propina de la factura»):
//   Una factura (`SimpleInvoice`) es SIEMPRE de una cuenta entera: la tabla
//   tiene `orderId @unique`. No hay facturas por parte de una cuenta: la
//   cuenta dividida tiene varios cobros pero una sola factura. Por eso la
//   parte de la propina que le toca a la factura es la propina de la cuenta,
//   y se toma el MÍNIMO de dos cifras, para no devolver nunca más de lo
//   cobrado:
//     1. la propina de la cuenta (`Order.tipCents`): lo que el asiento de
//        ventas acreditó a «propinas por pagar»;
//     2. lo cobrado de propina en los cobros de la cuenta
//        (`Payment.tipCents` de los cobros aprobados o reembolsados — un
//        cobro reembolsado sí se cobró; lo que ya salió por la pasarela lo
//        cruza la contabilidad como «reembolso anterior»). Efectivo, tarjeta,
//        datáfono y crédito de cliente cuentan igual: todos son propina
//        cobrada. Los cobros pendientes o rechazados no.
//   La propina congelada en la factura (`snapshot.tipCents`) NO se usa: una
//   factura emitida antes de cobrar no sabe todavía cuánta propina deja el
//   cliente, y la propina sigue siendo de esa cuenta.
//   Sin propina en cualquiera de las dos ⇒ 0.

/** Motivo DIAN de la anulación de factura electrónica. */
export const ANNULMENT_REASON_CODE = "2";

export function isAnnulmentReason(reasonCode: string | null | undefined): boolean {
  return reasonCode === ANNULMENT_REASON_CODE;
}

/** Estados de cobro cuya propina se cobró de verdad. */
export const TIP_COLLECTED_STATUSES = ["approved", "refunded"] as const;

export type TipPayment = {
  status: string;
  tipCents: number;
  /** Monto del cobro con propina (para «Cobrado»). */
  amountCents?: number;
  /** Quién cobró (mesero/operador); null = el comensal desde su QR. */
  collectedByUserId?: string | null;
};

export type InvoiceTipSource = {
  /** Propina de la cuenta (`Order.tipCents`). */
  orderTipCents: number | null | undefined;
  /** Cobros de la cuenta. */
  payments: readonly TipPayment[];
};

const cents = (n: unknown): number | null =>
  typeof n === "number" && Number.isSafeInteger(n) ? Math.max(0, n) : null;

const isCollected = (p: TipPayment) => (TIP_COLLECTED_STATUSES as readonly string[]).includes(p.status);
const collected = (p: TipPayment) => isCollected(p) && (cents(p.tipCents) ?? 0) > 0;

/** Propina efectivamente cobrada en los cobros de la cuenta. */
export function collectedTipCents(payments: readonly TipPayment[]): number {
  return payments.filter(collected).reduce((s, p) => s + (cents(p.tipCents) ?? 0), 0);
}

/** Lo cobrado en la cuenta (con propina): Σ cobros aprobados o reembolsados. */
export function collectedAmountCents(payments: readonly TipPayment[]): number {
  return payments.filter(isCollected).reduce((s, p) => s + (cents(p.amountCents) ?? 0), 0);
}

/**
 * Propina de la factura: el mínimo entre la de la cuenta y la cobrada (ver
 * la cabecera). Nunca negativa.
 */
export function invoiceTipCents(source: InvoiceTipSource): number {
  const order = cents(source.orderTipCents);
  const paid = collectedTipCents(source.payments);
  return order === null ? paid : Math.min(order, paid);
}

/** Propina que devuelve una nota con este motivo: toda la de la factura si es anulación; si no, 0. */
export function creditNoteTipRefundCents(reasonCode: string | null | undefined, source: InvoiceTipSource): number {
  return isAnnulmentReason(reasonCode) ? invoiceTipCents(source) : 0;
}

/**
 * Reparte la propina devuelta entre quienes la cobraron, en proporción a la
 * propina de cada cobro (resto mayor: la suma es exacta). Con política de
 * propinas por mesero, es lo que se le descuenta a cada uno. Sin cobros con
 * propina, queda sin dueño (`userId: null`).
 */
export function allocateTipByCollector(
  tipRefundCents: number,
  payments: readonly TipPayment[],
): Array<{ userId: string | null; cents: number }> {
  const refund = Math.max(0, Math.trunc(tipRefundCents));
  if (refund === 0) return [];
  const byUser = new Map<string | null, number>();
  for (const p of payments.filter(collected)) {
    const key = p.collectedByUserId ?? null;
    byUser.set(key, (byUser.get(key) ?? 0) + (cents(p.tipCents) ?? 0));
  }
  const total = [...byUser.values()].reduce((s, v) => s + v, 0);
  if (total <= 0) return [{ userId: null, cents: refund }];
  const entries = [...byUser.entries()].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""));
  const shares = entries.map(([userId, tip], i) => {
    const exact = (tip * refund) / total;
    return { i, userId, floor: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = refund - shares.reduce((s, x) => s + x.floor, 0);
  for (const sh of [...shares].sort((a, b) => b.rest - a.rest || a.i - b.i)) {
    if (left <= 0) break;
    sh.floor += 1;
    left -= 1;
  }
  return shares.filter((s) => s.floor > 0).map((s) => ({ userId: s.userId, cents: s.floor }));
}
