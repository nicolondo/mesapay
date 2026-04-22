import type { Prisma } from "@prisma/client";

/**
 * Counter-mode (food truck / mostrador) orders are prepay — their rounds are
 * created with status="open" so the kitchen board filter
 * (placed/in_kitchen/ready) ignores them. When the order is fully paid, this
 * helper flips any still-open rounds on that order to "placed" and sets
 * placedAt so the kitchen sees them.
 *
 * Idempotent: rounds that are already placed (table-mode) are left alone.
 */
export async function activateOpenRounds(
  tx: Prisma.TransactionClient,
  orderId: string,
) {
  const now = new Date();
  await tx.round.updateMany({
    where: { orderId, status: "open" },
    data: { status: "placed", placedAt: now },
  });
}
