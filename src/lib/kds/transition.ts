import type { Prisma } from "@prisma/client";
import {
  deriveRoundStatus,
  roundStatusData,
  type KitchenStatus,
} from "./roundStatus";

export type RoundRecompute = { status: KitchenStatus; becameReady: boolean };

/**
 * Re-deriva `Round.status` desde el estado ACTUAL de sus ítems vivos y
 * sella `kitchenStartedAt` / `readyAt` según corresponda (reglas en
 * ./roundStatus.ts). Se llama DESPUÉS de escribir los ítems y dentro de la
 * misma transacción: la lectura ya ve esas escrituras, así que no hace
 * falta pasarle aparte "el estado nuevo" del ítem tocado.
 *
 * Devuelve null si la ronda no existe — nada que recalcular.
 */
export async function recomputeRoundStatusInTx(
  tx: Prisma.TransactionClient,
  roundId: string,
  now: Date,
): Promise<RoundRecompute | null> {
  const siblings = await tx.orderItem.findMany({
    where: { roundId, cancelledAt: null },
    select: { kitchenStatus: true },
  });
  const status = deriveRoundStatus(siblings.map((s) => s.kitchenStatus));
  const round = await tx.round.findUnique({ where: { id: roundId } });
  if (!round) return null;
  const { data, becameReady } = roundStatusData(round, status, now);
  await tx.round.update({ where: { id: roundId }, data });
  return { status, becameReady };
}
