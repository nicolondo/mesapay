import type { Prisma } from "@prisma/client";
import {
  autoFireRoundInTx,
  autoFireStations,
  type AutoFiredRound,
} from "@/lib/kds/autoFire";

/**
 * Counter-mode (food truck / mostrador) orders are prepay — their rounds are
 * created with status="open" so the kitchen board filter
 * (placed/in_kitchen/ready) ignores them. When the order is fully paid, this
 * helper flips any still-open rounds on that order to "placed" and sets
 * placedAt so the kitchen sees them.
 *
 * Idempotent: rounds that are already placed (table-mode) are left alone.
 *
 * Marchado automático: una ronda prepaga NO se marcha al crearse (sería
 * preparar algo que quizá no se paga); se marcha acá, en el mismo instante
 * en que entra al tablero. Devuelve los grupos marchados para que quien
 * llama imprima las comandas DESPUÉS de commitear
 * (`notifyAutoFiredTickets`). Sin rondas que activar (mesa) o sin auto-fire
 * en ninguna estación devuelve [] y la escritura queda igual que antes.
 */
export async function activateOpenRounds(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<AutoFiredRound[]> {
  const now = new Date();
  const activated = await tx.round.updateMany({
    where: { orderId, status: "open" },
    data: { status: "placed", placedAt: now },
  });
  if (activated.count === 0) return [];

  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      restaurant: { select: { kitchenAutoFire: true, barAutoFire: true } },
    },
  });
  if (!order || autoFireStations(order.restaurant).length === 0) return [];

  // Todas las rondas "placed" de la cuenta, no sólo las recién activadas:
  // el helper únicamente toca ítems "placed", así que una ronda activada (y
  // marchada) en un pago anterior sale vacía y no se re-imprime.
  const rounds = await tx.round.findMany({
    where: { orderId, status: "placed" },
    select: { id: true },
  });
  const fired: AutoFiredRound[] = [];
  for (const round of rounds) {
    const groups = await autoFireRoundInTx(tx, {
      roundId: round.id,
      flags: order.restaurant,
      now,
    });
    if (groups.length > 0) fired.push({ roundId: round.id, groups });
  }
  return fired;
}
