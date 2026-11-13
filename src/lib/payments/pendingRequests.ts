import type { Prisma } from "@prisma/client";
import { PUSHABLE_REQUEST_METHODS, isReplaceablePending, terminalClaimKey } from "./methods";
import { toTerminalAttemptView, type TerminalAttemptView } from "./terminalAttempt";
import { toTerminalAmountView, type TerminalAmountView } from "./terminalAmount";

/**
 * Lado servidor de `isReplaceablePending` (methods.ts): averigua qué pagos
 * del Smart POS de Kushki ya se empujaron al equipo, para separar la
 * solicitud ("se pidió el datáfono") del cobro en vuelo.
 *
 * El reclamo `terminal:<paymentId>` lo crea `terminal/charge` dentro de una
 * transacción con `lockOrder`, después de re-verificar que el pago sigue
 * `pending` y ANTES de llamar a Kushki. Quien lea esto bajo el mismo
 * `lockOrder` ve una de dos: o el reclamo ya está (en vuelo) o, si declina
 * la solicitud primero, `terminal/charge` encuentra el pago `declined` y no
 * empuja nada. No hay ventana en la que se cobre dos veces.
 */

type Client = Pick<Prisma.TransactionClient, "financialOperation">;

/** El reclamo `terminal:<id>` de un pago: cuándo se envió y qué contestó el equipo. */
export type TerminalClaim = {
  createdAt: Date;
  deviceId: string | null;
  answerCode: string | null;
  answerMessage: string | null;
  answeredAt: Date | null;
  nextPaymentId: string | null;
  /** Lo que se mandó al datáfono. */
  amountCents: number;
  /** Kushki autorizó otro monto, y qué se hizo (terminalAmount.ts). */
  authorizedCents: number | null;
  amountCheck: string | null;
};

/**
 * El reclamo de cada pago (de los dados) que se empujó al datáfono:
 * `paymentId → reclamo`. Sólo consulta si hay algún método que lo necesite:
 * con efectivo o datáfono propio no toca la base.
 */
export async function terminalClaims(
  client: Client,
  payments: ReadonlyArray<{ id: string; method: string }>,
): Promise<Map<string, TerminalClaim>> {
  const ids = payments
    .filter((p) => (PUSHABLE_REQUEST_METHODS as readonly string[]).includes(p.method))
    .map((p) => p.id);
  if (ids.length === 0) return new Map();
  const ops = await client.financialOperation.findMany({
    where: { key: { in: ids.map(terminalClaimKey) } },
    select: {
      paymentId: true,
      createdAt: true,
      deviceId: true,
      answerCode: true,
      answerMessage: true,
      answeredAt: true,
      nextPaymentId: true,
      amountCents: true,
      authorizedCents: true,
      amountCheck: true,
    },
  });
  return new Map(
    ops.map((o) => [
      o.paymentId,
      {
        createdAt: o.createdAt,
        deviceId: o.deviceId ?? null,
        answerCode: o.answerCode ?? null,
        answerMessage: o.answerMessage ?? null,
        answeredAt: o.answeredAt ?? null,
        nextPaymentId: o.nextPaymentId ?? null,
        amountCents: o.amountCents,
        // BIGINT en la base: a número (cabe de sobra en un double).
        authorizedCents: o.authorizedCents == null ? null : Number(o.authorizedCents),
        amountCheck: o.amountCheck ?? null,
      },
    ]),
  );
}

/**
 * Cobros del datáfono Kushki que Kushki aprobó por OTRO monto (propina o
 * parcial, o pendientes por «monto cobrado distinto»): `paymentId → vista`.
 * Para los avisos de Cobros, la ficha y «Mesas en vivo».
 */
export async function terminalAmountViews(
  client: Client,
  payments: ReadonlyArray<{ id: string; method: string }>,
): Promise<Map<string, TerminalAmountView>> {
  const claims = await terminalClaims(
    client,
    payments.filter((p) => p.method === "kushki_card_terminal"),
  );
  const views = new Map<string, TerminalAmountView>();
  for (const [paymentId, claim] of claims) {
    const view = toTerminalAmountView(claim);
    if (view) views.set(paymentId, view);
  }
  return views;
}

/** Ids (de los pagos dados) que tienen el reclamo del datáfono. */
export async function terminalClaimedIds(
  client: Client,
  payments: ReadonlyArray<{ id: string; method: string }>,
): Promise<Set<string>> {
  return new Set((await terminalClaims(client, payments)).keys());
}

/**
 * Cada pago con `replaceable` ya calculado (lo que las pantallas reciben para
 * decidir si muestran "Cancelar solicitud" o "esperando resultado"),
 * `pushedAt` (cuándo se envió al datáfono, para habilitar
 * "Resolver cobro"; null = nunca se envió) y `terminalAttempt`: qué se sabe
 * del intento enviado (en curso, el equipo contestó que no, sin respuesta).
 */
export async function withReplaceable<
  T extends {
    id: string;
    method: string;
    status: string;
    providerRef: string | null;
    reconciliationRequired?: boolean;
  },
>(
  client: Client,
  payments: readonly T[],
): Promise<
  Array<T & { replaceable: boolean; pushedAt: Date | null; terminalAttempt: TerminalAttemptView | null }>
> {
  const claims = await terminalClaims(
    client,
    payments.filter((p) => p.status === "pending"),
  );
  return payments.map((p) => {
    const claim = claims.get(p.id);
    return {
      ...p,
      replaceable: isReplaceablePending(p, !!claim),
      pushedAt: claim?.createdAt ?? null,
      terminalAttempt: toTerminalAttemptView(claim, p.reconciliationRequired === true),
    };
  });
}
