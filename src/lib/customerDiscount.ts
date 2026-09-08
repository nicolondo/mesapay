/**
 * Descuento por comensal identificado en la cuenta.
 *
 * Reglas del feature:
 *   - El descuento es un PORCENTAJE sobre la cuenta.
 *   - Es por restaurante (ver el modelo CustomerDiscount y el porqué).
 *   - Se aplica al identificar al cliente en la cuenta de una mesa.
 *   - El mesero lo puede quitar.
 */

import type { Prisma } from "@prisma/client";
import { db } from "./db";

export const MIN_DISCOUNT_PCT = 1;
export const MAX_DISCOUNT_PCT = 100;

/**
 * Valor en centavos de un descuento porcentual sobre el subtotal.
 *
 * Pura (sin DB) para poder probarla. Redondea al peso más cercano y nunca
 * devuelve más que el subtotal — un descuento no puede volver la cuenta
 * negativa ni siquiera con un 100 % sobre un subtotal raro.
 */
export function computeDiscountCents(
  subtotalCents: number,
  percent: number | null | undefined,
): number {
  if (!percent || percent <= 0) return 0;
  if (subtotalCents <= 0) return 0;
  const capped = Math.min(percent, MAX_DISCOUNT_PCT);
  return Math.min(subtotalCents, Math.round((subtotalCents * capped) / 100));
}

/** true si el porcentaje está en el rango aceptado. */
export function isValidDiscountPct(percent: number): boolean {
  return (
    Number.isInteger(percent) &&
    percent >= MIN_DISCOUNT_PCT &&
    percent <= MAX_DISCOUNT_PCT
  );
}

/**
 * Porcentaje vigente para ese comensal EN ESE RESTAURANTE, o null.
 *
 * El `restaurantId` en el where no es decorativo: es lo que impide que el
 * descuento pactado por un restaurante se aplique en otro.
 */
export async function getActiveDiscountPct(
  restaurantId: string,
  userId: string,
): Promise<number | null> {
  const row = await db.customerDiscount.findUnique({
    where: { restaurantId_userId: { restaurantId, userId } },
    select: { percent: true, active: true },
  });
  if (!row || !row.active) return null;
  return row.percent;
}

export type IdentifyResult = {
  userId: string;
  name: string | null;
  discountPct: number | null;
  discountCents: number;
};

/**
 * Enlaza al comensal con la cuenta y aplica su descuento si tiene uno
 * vigente en ESTE restaurante.
 *
 * Se valida que la orden pertenezca al restaurante que la pide: sin eso, un
 * operador podría identificar comensales en cuentas ajenas.
 */
export async function applyCustomerToOrder(args: {
  orderId: string;
  restaurantId: string;
  userId: string;
}): Promise<IdentifyResult | null> {
  const order = await db.order.findUnique({
    where: { id: args.orderId },
    select: { id: true, restaurantId: true, subtotalCents: true, status: true },
  });
  if (!order || order.restaurantId !== args.restaurantId) return null;
  // Una cuenta ya pagada no se re-descuenta: el dinero ya se movió.
  if (order.status === "paid") return null;

  const user = await db.user.findUnique({
    where: { id: args.userId },
    select: { id: true, name: true },
  });
  if (!user) return null;

  const pct = await getActiveDiscountPct(args.restaurantId, args.userId);
  const discountCents = computeDiscountCents(order.subtotalCents, pct);

  await db.order.update({
    where: { id: order.id },
    data: {
      customerId: user.id,
      discountPct: pct,
      discountCents,
      // El total tiene que reflejar el descuento de una vez; el resto de
      // los caminos lo recalculan con recompute/sync.
      totalCents: Math.max(0, order.subtotalCents - discountCents),
    },
  });

  return {
    userId: user.id,
    name: user.name,
    discountPct: pct,
    discountCents,
  };
}

/**
 * Quita el descuento de la cuenta (acción del mesero). Deja al comensal
 * identificado: quitar el beneficio no es lo mismo que borrar quién es.
 */
export async function removeOrderDiscount(args: {
  orderId: string;
  restaurantId: string;
}): Promise<boolean> {
  const res = await db.order.updateMany({
    // El restaurantId acá también es el que evita tocar cuentas ajenas.
    where: {
      id: args.orderId,
      restaurantId: args.restaurantId,
      status: { not: "paid" },
    },
    data: { discountPct: null, discountCents: 0 },
  });
  return res.count > 0;
}

/**
 * Recalcula `discountCents` a partir del `discountPct` guardado. Se llama
 * cuando cambia el subtotal (el comensal pidió otro plato, se canceló una
 * ronda): el porcentaje es el pactado, el valor tiene que seguir a la
 * cuenta.
 */
export function recalcDiscountForSubtotal(
  order: { discountPct: number | null },
  subtotalCents: number,
): number {
  return computeDiscountCents(subtotalCents, order.discountPct);
}

/**
 * Busca un comensal por cédula o correo exactos. Devuelve SOLO datos de
 * identidad — nunca su consumo en otros restaurantes.
 */
export async function findCustomerByIdentifier(
  where: Prisma.UserWhereUniqueInput,
) {
  return db.user.findUnique({
    where,
    select: {
      id: true,
      name: true,
      email: true,
      cedula: true,
      role: true,
      disabledAt: true,
    },
  });
}
