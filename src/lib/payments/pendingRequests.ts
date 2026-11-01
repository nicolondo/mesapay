import type { Prisma } from "@prisma/client";
import { PUSHABLE_REQUEST_METHODS, isReplaceablePending, terminalClaimKey } from "./methods";

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

/**
 * Cuándo se empujó al datáfono cada pago (de los dados) que tiene el
 * reclamo: `paymentId → createdAt` del reclamo. Sólo consulta si hay algún
 * método que lo necesite: con efectivo o datáfono propio no toca la base.
 */
export async function terminalClaims(
  client: Client,
  payments: ReadonlyArray<{ id: string; method: string }>,
): Promise<Map<string, Date>> {
  const ids = payments
    .filter((p) => (PUSHABLE_REQUEST_METHODS as readonly string[]).includes(p.method))
    .map((p) => p.id);
  if (ids.length === 0) return new Map();
  const ops = await client.financialOperation.findMany({
    where: { key: { in: ids.map(terminalClaimKey) } },
    select: { paymentId: true, createdAt: true },
  });
  return new Map(ops.map((o) => [o.paymentId, o.createdAt]));
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
 * decidir si muestran "Cancelar solicitud" o "esperando resultado") y
 * `pushedAt`: cuándo se envió al datáfono, para la cuenta regresiva de
 * "Resolver cobro". null = nunca se envió.
 */
export async function withReplaceable<
  T extends { id: string; method: string; status: string; providerRef: string | null },
>(
  client: Client,
  payments: readonly T[],
): Promise<Array<T & { replaceable: boolean; pushedAt: Date | null }>> {
  const claims = await terminalClaims(
    client,
    payments.filter((p) => p.status === "pending"),
  );
  return payments.map((p) => ({
    ...p,
    replaceable: isReplaceablePending(p, claims.has(p.id)),
    pushedAt: claims.get(p.id) ?? null,
  }));
}
