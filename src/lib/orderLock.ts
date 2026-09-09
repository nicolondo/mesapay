import type { Prisma } from "@prisma/client";

/** Serialize all writers of an order before reading its mutable state. */
export async function lockOrder(tx: Prisma.TransactionClient, orderId: string) {
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
}

/** Consistent restaurant-level stock lock also covers multi-ingredient batches. */
export async function lockStock(tx: Prisma.TransactionClient, restaurantId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${restaurantId}), 731)`;
}
