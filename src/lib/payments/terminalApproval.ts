import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { publishOrderEvent } from "@/lib/events";
import { markPaymentUncertain } from "./intent";
import { terminalClaimKey } from "./methods";
import {
  DEFAULT_TERMINAL_EXTRA_CAP,
  classifyTerminalAmount,
  toTerminalAmountView,
  type TerminalAmountMismatch,
  type TerminalAmountVerdict,
  type TerminalExtraCap,
} from "./terminalAmount";
import { processKushkiWebhook } from "./webhookHandler";

/**
 * Un cobro del datáfono Kushki que Kushki dice APROBADO: se liquida por lo
 * que de verdad se autorizó. Un solo camino para el cobro síncrono
 * (`terminal/charge`), la búsqueda posterior (`transaction_search_online`,
 * terminalRecovery.ts) y el mock, así que los dos primeros nunca cuentan dos
 * veces (mismo `eventId` `cloudterm:<paymentId>:ok`).
 *
 *   - autorizó lo de la cuenta → se salda como siempre;
 *   - de más (dentro del tope) → propina cobrada en el datáfono;
 *   - de menos → aprobado parcial, el saldo queda pendiente;
 *   - otro caso (sobre el tope, unidades, sin monto legible, o una
 *     diferencia sin código de aprobación) → queda para conciliar con el
 *     motivo en el reclamo: las pantallas dicen «monto cobrado distinto», no
 *     «sin respuesta».
 *
 * Ver terminalAmount.ts para la regla y el caso real que la originó.
 */

/** El tope de la propina del datáfono (env, con defaults). Nunca lanza. */
export function terminalExtraCap(): TerminalExtraCap {
  let percent: number | undefined;
  let cents: number | undefined;
  try {
    percent = env.KUSHKI_TERMINAL_TIP_MAX_PERCENT;
    cents = env.KUSHKI_TERMINAL_TIP_MAX_CENTS;
  } catch {
    return DEFAULT_TERMINAL_EXTRA_CAP;
  }
  return {
    maxPercent: typeof percent === "number" && Number.isFinite(percent) ? percent : DEFAULT_TERMINAL_EXTRA_CAP.maxPercent,
    maxCents: typeof cents === "number" && Number.isFinite(cents) ? cents : DEFAULT_TERMINAL_EXTRA_CAP.maxCents,
  };
}

export type TerminalApprovalSource = "sync_charge" | "transaction_search_online" | "mock";

export type TerminalApprovalInput = {
  restaurantId: string;
  paymentId: string;
  /** Lo que se mandó al datáfono (`Payment.amountCents`, el TOTAL). */
  expectedCents: number;
  providerRef: string;
  /**
   * Lo que Kushki dice que autorizó, en centavos. `undefined` = no lo dijo
   * (el aprobado síncrono de siempre): se toma como la cuenta. `null` = lo
   * dijo pero no se pudo leer.
   */
  authorizedCents: number | null | undefined;
  approvalCode?: string | null;
  /**
   * Aprobación inequívoca: además de `approved`, un código de aprobación (o
   * el `responseCode` 00 del adquirente). Sin ella una diferencia no se
   * liquida sola.
   */
  confirmed: boolean;
  source: TerminalApprovalSource;
  /** Default `cloudterm:<paymentId>:ok` (compartido por cobro y búsqueda). */
  eventId?: string;
  message?: string;
  raw?: unknown;
};

/** Lo que quedó registrado cuando el monto autorizado no fue el de la cuenta. */
export type TerminalAdjustment = {
  check: "tip" | "partial";
  expectedCents: number;
  authorizedCents: number;
  /** De más (propina) o de menos (saldo pendiente), siempre positivo. */
  diffCents: number;
};

export type TerminalApprovalOutcome =
  | { status: "approved"; providerRef: string; adjustment: TerminalAdjustment | null }
  | { status: "amount_mismatch"; reason: TerminalAmountMismatch; authorizedCents: number | null }
  /** Era definitivo pero no se pudo registrar: quien llama lo deja incierto. */
  | { status: "settle_failed" };

/** Lo accesorio nunca tumba el cobro. */
async function quietly(task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (err) {
    console.warn("[terminal-approval] no se pudo dejar constancia", err);
  }
}

/** Qué se hace con lo que Kushki autorizó (sin tocar nada). */
export function terminalApprovalVerdict(
  input: Pick<TerminalApprovalInput, "expectedCents" | "authorizedCents" | "confirmed">,
  cap?: TerminalExtraCap,
): TerminalAmountVerdict {
  if (input.authorizedCents === undefined || input.authorizedCents === input.expectedCents) {
    return { kind: "exact", authorizedCents: input.expectedCents };
  }
  const verdict = classifyTerminalAmount(input.expectedCents, input.authorizedCents, cap ?? terminalExtraCap());
  if ((verdict.kind === "tip" || verdict.kind === "partial") && !input.confirmed) {
    return { kind: "mismatch", reason: "unconfirmed", authorizedCents: verdict.authorizedCents };
  }
  return verdict;
}

export async function settleTerminalApproval(input: TerminalApprovalInput): Promise<TerminalApprovalOutcome> {
  const verdict = terminalApprovalVerdict(input);
  if (verdict.kind === "mismatch") {
    await holdForReconciliation(input, verdict.reason, verdict.authorizedCents);
    return { status: "amount_mismatch", reason: verdict.reason, authorizedCents: verdict.authorizedCents };
  }
  const adjusted = verdict.kind === "tip" || verdict.kind === "partial";
  const processed = await processKushkiWebhook({
    eventId: input.eventId ?? `cloudterm:${input.paymentId}:ok`,
    type: "terminal.approved",
    restaurantId: input.restaurantId,
    paymentId: input.paymentId,
    providerRef: input.providerRef,
    message: input.message,
    raw: input.raw,
    ...(adjusted
      ? {
          authorizedCents: verdict.authorizedCents,
          expectedCents: input.expectedCents,
          approvalCode: input.approvalCode ?? null,
          amountSource: input.source,
        }
      : {}),
  });
  if (processed.status === "error" || processed.requiresReview) return { status: "settle_failed" };
  // El código de aprobación queda donde Cobros lo muestra.
  if (input.approvalCode) {
    const approvalCode = input.approvalCode;
    await quietly(() =>
      db.kushkiTransaction.updateMany({
        where: { kushkiTxId: input.providerRef, paymentId: input.paymentId },
        data: { approvalCode },
      }),
    );
  }
  // Lo que QUEDÓ registrado (si el cobro y la búsqueda llegaron los dos, vale
  // el primero), no lo que dijo esta respuesta.
  let adjustment: TerminalAdjustment | null = null;
  await quietly(async () => {
    const claim = await db.financialOperation.findUnique({ where: { key: terminalClaimKey(input.paymentId) } });
    const view = toTerminalAmountView(claim);
    if (view && (view.check === "tip" || view.check === "partial") && view.authorizedCents != null) {
      adjustment = {
        check: view.check,
        expectedCents: view.expectedCents,
        authorizedCents: view.authorizedCents,
        diffCents: Math.abs(view.authorizedCents - view.expectedCents),
      };
    }
  });
  return { status: "approved", providerRef: input.providerRef, adjustment };
}

/**
 * Aprobado por un monto que no se liquida solo: el pago queda pendiente y
 * marcado para conciliar (la cuenta sigue bloqueada, como un cobro sin
 * respuesta), pero el reclamo dice POR QUÉ, para que las pantallas muestren
 * «monto cobrado distinto» con los dos montos.
 */
async function holdForReconciliation(
  input: TerminalApprovalInput,
  reason: TerminalAmountMismatch,
  authorizedCents: number | null,
) {
  console.error("[kushki/cloud-terminal] aprobado por un monto que no se liquida solo", {
    paymentId: input.paymentId,
    expectedCents: input.expectedCents,
    authorizedCents,
    reason,
    source: input.source,
  });
  await quietly(() =>
    db.financialOperation.updateMany({
      where: { key: terminalClaimKey(input.paymentId), paymentId: input.paymentId },
      data: { authorizedCents, amountCheck: reason },
    }),
  );
  await markPaymentUncertain(input.paymentId);
  await quietly(() =>
    db.auditEvent.create({
      data: {
        restaurantId: input.restaurantId,
        actorEmail: "kushki",
        actorRole: "system",
        kind: "payment.terminal_amount_mismatch",
        targetType: "payment",
        targetId: input.paymentId,
        summary: "El datáfono aprobó un monto distinto al de la cuenta: queda para conciliar.",
        diff: {
          expectedCents: input.expectedCents,
          authorizedCents,
          reason,
          approvalCode: input.approvalCode ?? null,
          providerRef: input.providerRef,
          source: input.source,
        },
      },
    }),
  );
  await quietly(async () => {
    const payment = await db.payment.findUnique({ where: { id: input.paymentId }, select: { orderId: true } });
    if (payment) publishOrderEvent(input.restaurantId, { type: "order.updated", orderId: payment.orderId });
  });
}
