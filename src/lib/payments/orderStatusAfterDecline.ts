import type { OrderStatus, Prisma } from "@prisma/client";

/**
 * Después de declinar un pago: si la cuenta quedó en `paying` sin ningún
 * pago pendiente ni aprobado, vuelve al estado de su cocina (`open`,
 * `placed`, `in_kitchen`, `ready` o `served`), para que el Salón y las
 * mesas no la sigan mostrando "pagando".
 *
 * Es la regla que ya aplicaba el rechazo de Kushki (webhook / datáfono);
 * vive acá para que "Cancelar solicitud" haga exactamente lo mismo. Sólo
 * dentro de la transacción, bajo `lockOrder`. Devuelve el estado nuevo, o
 * null si no cambió nada.
 */
export async function releaseOrderFromPaying(
  tx: Prisma.TransactionClient,
  orderId: string,
  currentStatus: OrderStatus | string,
): Promise<OrderStatus | null> {
  if (currentStatus !== "paying") return null;
  const live = await tx.payment.count({ where: { orderId, status: { in: ["pending", "approved"] } } });
  if (live > 0) return null;
  const rounds = await tx.round.findMany({
    where: { orderId, status: { not: "cancelled" } },
    select: { status: true },
  });
  const status: OrderStatus = !rounds.length
    ? "open"
    : rounds.every((r) => r.status === "served")
      ? "served"
      : rounds.every((r) => r.status === "ready")
        ? "ready"
        : rounds.some((r) => r.status === "in_kitchen")
          ? "in_kitchen"
          : "placed";
  await tx.order.update({ where: { id: orderId }, data: { status } });
  return status;
}
