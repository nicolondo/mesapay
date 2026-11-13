/**
 * El datáfono Kushki APROBÓ, pero por un monto distinto al de la cuenta.
 *
 * Caso real (producción, 2026-11-13): MESAPAY mandó $5.520 y Kushki contestó
 * `approved: true`, `responseCode: "00"`, `authorized_amount: 5525`. El
 * voucher salió y el dinero se cobró, pero el pago quedó «sin respuesta»
 * porque cualquier diferencia se trataba como incierta. Origen probable: la
 * propina que el equipo pide en pantalla (o un redondeo del terminal).
 *
 * La regla:
 *   - igual → se salda como siempre;
 *   - de MÁS, dentro del tope → la diferencia es propina cobrada en el
 *     datáfono (`tipCents` del pago y, por `recomputeOrderTotalsInTx`, de la
 *     orden): la factura muestra «Propina voluntaria» y el total real;
 *   - de MENOS → aprobado parcial: se registra lo autorizado y el saldo queda
 *     pendiente en la cuenta para cobrarlo de otra forma;
 *   - por encima del tope, un error de unidades (×100 / ÷100) o un monto
 *     ilegible → NO se decide solo: queda para conciliar con el comprobante.
 *
 * Un error de unidades NUNCA se interpreta como propina ni como parcial: en
 * COP Kushki ONE espera pesos enteros y «si agregas 00 al final, cobrarás
 * 100 veces más» (#567). Por eso un monto cercano a ×100 o ÷100 de la cuenta
 * va a conciliar aunque cupiera en el tope.
 *
 * Archivo sin dependencias de servidor: lo usan el cobro, la búsqueda, el
 * mock y las pantallas.
 */

/** Tope de lo que se acepta solo como propina del datáfono. */
export type TerminalExtraCap = {
  /** Porcentaje de la cuenta (lo que se mandó al datáfono). */
  maxPercent: number;
  /** Monto absoluto en centavos. */
  maxCents: number;
};

/**
 * 30 % de la cuenta o $200.000 COP, lo que pase primero. Configurable con
 * `KUSHKI_TERMINAL_TIP_MAX_PERCENT` / `KUSHKI_TERMINAL_TIP_MAX_CENTS`
 * (ver `terminalExtraCap` en terminalApproval.ts).
 */
export const DEFAULT_TERMINAL_EXTRA_CAP: TerminalExtraCap = { maxPercent: 30, maxCents: 20_000_000 };

/** Por qué una aprobación no se pudo liquidar sola. */
export type TerminalAmountMismatch = "over_cap" | "units" | "invalid" | "unconfirmed";

/** Lo que se hizo con el monto autorizado (`FinancialOperation.amountCheck`). */
export type TerminalAmountCheck = "tip" | "partial" | TerminalAmountMismatch;

export type TerminalAmountVerdict =
  | { kind: "exact"; authorizedCents: number }
  /** De más, dentro del tope: `diffCents` > 0 es la propina del datáfono. */
  | { kind: "tip"; authorizedCents: number; diffCents: number }
  /** De menos: `diffCents` > 0 es lo que falta por cobrar. */
  | { kind: "partial"; authorizedCents: number; diffCents: number }
  | { kind: "mismatch"; reason: TerminalAmountMismatch; authorizedCents: number | null };

const MISMATCHES: ReadonlySet<string> = new Set(["over_cap", "units", "invalid", "unconfirmed"]);

export function isTerminalAmountMismatch(check: string | null | undefined): check is TerminalAmountMismatch {
  return !!check && MISMATCHES.has(check);
}

/**
 * Un monto de Kushki en PESOS (`authorized_amount`,
 * `approved_transaction_amount`) a centavos. null si no es un número
 * positivo con máximo dos decimales.
 */
export function pesosToCents(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  const cents = Math.round(n * 100);
  if (Math.abs(n * 100 - cents) > 1e-6 || !Number.isSafeInteger(cents)) return null;
  return cents;
}

/** ¿`value` cae dentro de ±`percent` % de `target`? */
function near(value: number, target: number, percent: number): boolean {
  return Math.abs(value - target) <= (target * percent) / 100;
}

/**
 * Compara lo que Kushki autorizó con lo que se mandó (los dos en centavos).
 * `authorizedCents` null = Kushki no dijo un monto legible.
 */
export function classifyTerminalAmount(
  expectedCents: number,
  authorizedCents: number | null,
  cap: TerminalExtraCap = DEFAULT_TERMINAL_EXTRA_CAP,
): TerminalAmountVerdict {
  if (authorizedCents == null || !Number.isSafeInteger(authorizedCents) || authorizedCents <= 0 || expectedCents <= 0) {
    return { kind: "mismatch", reason: "invalid", authorizedCents: authorizedCents ?? null };
  }
  if (authorizedCents === expectedCents) return { kind: "exact", authorizedCents };
  // ×100 / ÷100 (o muy cerca): pesos contra centavos. Nunca propina ni parcial.
  const unitsWindow = Math.max(cap.maxPercent, 1);
  if (near(authorizedCents, expectedCents * 100, unitsWindow) || near(authorizedCents * 100, expectedCents, unitsWindow)) {
    return { kind: "mismatch", reason: "units", authorizedCents };
  }
  const diff = authorizedCents - expectedCents;
  if (diff > 0) {
    const overPercent = diff * 100 > expectedCents * cap.maxPercent;
    if (overPercent || diff > cap.maxCents) return { kind: "mismatch", reason: "over_cap", authorizedCents };
    return { kind: "tip", authorizedCents, diffCents: diff };
  }
  return { kind: "partial", authorizedCents, diffCents: -diff };
}

/**
 * Cómo queda el pago aprobado por `authorizedCents` en vez de su monto:
 *   - de más: todo lo de más es propina (la comida no cambia);
 *   - de menos: se conserva la propina que el comensal eligió (hasta lo
 *     autorizado) y lo que falta queda como saldo de la cuenta. Así lo
 *     pendiente es exactamente lo que no se cobró.
 */
export function adjustedTerminalPayment(
  payment: { amountCents: number; tipCents: number },
  authorizedCents: number,
): { amountCents: number; tipCents: number } {
  const diff = authorizedCents - payment.amountCents;
  if (diff >= 0) return { amountCents: authorizedCents, tipCents: payment.tipCents + diff };
  return { amountCents: authorizedCents, tipCents: Math.min(payment.tipCents, authorizedCents) };
}

/** Lo que las pantallas muestran de un cobro del datáfono con otro monto. */
export type TerminalAmountView = {
  check: TerminalAmountCheck;
  /** Lo que se mandó al datáfono (la cuenta). */
  expectedCents: number;
  /** Lo que Kushki autorizó; null si no lo dijo de forma legible. */
  authorizedCents: number | null;
};

/**
 * Del reclamo `terminal:<id>`: null si autorizó lo de la cuenta (o el reclamo
 * es de antes de este cambio).
 */
export function toTerminalAmountView(
  claim: { amountCents: number; authorizedCents?: number | null; amountCheck?: string | null } | null | undefined,
): TerminalAmountView | null {
  const check = claim?.amountCheck;
  if (!claim || !check) return null;
  if (check !== "tip" && check !== "partial" && !isTerminalAmountMismatch(check)) return null;
  if ((check === "tip" || check === "partial") && claim.authorizedCents == null) return null;
  return { check, expectedCents: claim.amountCents, authorizedCents: claim.authorizedCents ?? null };
}
