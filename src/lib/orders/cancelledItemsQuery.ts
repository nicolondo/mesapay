import { db } from "@/lib/db";
import { getCurrencyForCountry, type Currency } from "@/lib/billing/countries";
import {
  buildCancelledItems,
  cancellationEmails,
  type CancelledItemView,
  type StaffDirectoryEntry,
} from "./cancelledItems";

/**
 * Nombres del personal de `restaurantId` para los correos dados. Sólo
 * usuarios de ESE comercio: un correo de otro (o de un administrador de la
 * plataforma) no se resuelve y la ficha muestra el correo. Una consulta para
 * todos los correos.
 */
export async function loadStaffNamesByEmail(
  restaurantId: string,
  emails: string[],
): Promise<StaffDirectoryEntry[]> {
  if (emails.length === 0) return [];
  return db.user.findMany({
    where: { restaurantId, email: { in: emails } },
    select: { email: true, name: true },
  });
}

/**
 * Platos cancelados de una cuenta del comercio `restaurantId`, ya con nombres
 * y la moneda del comercio. null si la cuenta no existe o es de otro
 * comercio. Tres consultas fijas, sin importar cuántos platos haya: la cuenta
 * (rondas + platos cancelados), el personal y la moneda.
 */
export async function loadOrderCancelledItems(
  orderId: string,
  restaurantId: string,
): Promise<{ currency: Currency; items: CancelledItemView[] } | null> {
  const order = await db.order.findFirst({
    where: { id: orderId, restaurantId },
    select: {
      restaurant: { select: { country: true } },
      rounds: {
        select: {
          id: true,
          seq: true,
          status: true,
          cancelledAt: true,
          cancelledByEmail: true,
          cancellationReason: true,
        },
      },
      items: {
        // Cancelados uno a uno, o vivos dentro de una ronda cancelada.
        where: {
          OR: [{ cancelledAt: { not: null } }, { round: { status: "cancelled" } }],
        },
        orderBy: { id: "asc" },
        select: {
          id: true,
          roundId: true,
          nameSnapshot: true,
          qty: true,
          priceCentsSnapshot: true,
          cancelledAt: true,
          cancelledByEmail: true,
          cancellationReason: true,
          cancellationKind: true,
        },
      },
    },
  });
  if (!order) return null;
  const [staff, currency] = await Promise.all([
    loadStaffNamesByEmail(restaurantId, cancellationEmails(order.items, order.rounds)),
    getCurrencyForCountry(order.restaurant.country),
  ]);
  return {
    currency,
    items: buildCancelledItems({ items: order.items, rounds: order.rounds, staff }),
  };
}
