/**
 * Descuento por comensal identificado en la cuenta.
 *
 * Reglas del feature:
 *   - El descuento es un PORCENTAJE sobre la cuenta.
 *   - Es del comercio: el comensal pertenece a UNO, así que el descuento no
 *     puede viajar a otro local ni por accidente (ver el modelo Diner).
 *   - Se aplica al identificar al cliente en la cuenta de una mesa.
 *   - El mesero lo puede quitar.
 */

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
 * Porcentaje vigente para ese comensal, o null.
 *
 * Ya no hace falta pasar el restaurante: el descuento cuelga del comensal,
 * y el comensal cuelga de un solo comercio.
 */
export async function getActiveDiscountPct(
  dinerId: string,
): Promise<number | null> {
  const row = await db.dinerDiscount.findUnique({
    where: { dinerId },
    select: { percent: true, active: true },
  });
  if (!row || !row.active) return null;
  return row.percent;
}

export type IdentifyResult = {
  dinerId: string;
  name: string | null;
  discountPct: number | null;
  discountCents: number;
};

/**
 * Enlaza al comensal con la cuenta y aplica su descuento si tiene uno
 * vigente.
 *
 * Se valida que la orden Y el comensal pertenezcan al mismo restaurante:
 * sin eso, un operador podría identificar comensales en cuentas ajenas, o
 * pegar un comensal de otro local a una cuenta de este.
 */
export async function applyDinerToOrder(args: {
  orderId: string;
  restaurantId: string;
  dinerId: string;
}): Promise<IdentifyResult | null> {
  const order = await db.order.findUnique({
    where: { id: args.orderId },
    select: { id: true, restaurantId: true, subtotalCents: true, status: true },
  });
  if (!order || order.restaurantId !== args.restaurantId) return null;
  // Una cuenta ya pagada no se re-descuenta: el dinero ya se movió.
  if (order.status === "paid") return null;

  const diner = await db.diner.findUnique({
    where: { id: args.dinerId },
    select: { id: true, name: true, restaurantId: true },
  });
  if (!diner || diner.restaurantId !== args.restaurantId) return null;

  const pct = await getActiveDiscountPct(diner.id);
  const discountCents = computeDiscountCents(order.subtotalCents, pct);

  await db.order.update({
    where: { id: order.id },
    data: {
      dinerId: diner.id,
      discountPct: pct,
      discountCents,
      // El total tiene que reflejar el descuento de una vez; el resto de
      // los caminos lo recalculan con recompute/sync.
      totalCents: Math.max(0, order.subtotalCents - discountCents),
    },
  });

  return {
    dinerId: diner.id,
    name: diner.name,
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
 * Busca un comensal DE ESTE COMERCIO por cédula o correo exactos.
 *
 * El `restaurantId` va en la llave compuesta, no como filtro opcional: es
 * lo que hace que el buscador de la mesa no sea un directorio de los
 * comensales de los demás restaurantes de la plataforma. Antes la identidad
 * era global y este lookup encontraba a cualquiera; hoy, si la persona no
 * tiene cuenta acá, no existe acá.
 */
export async function findDinerByIdentifier(args: {
  restaurantId: string;
  email?: string;
  cedula?: string;
}) {
  const select = {
    id: true,
    name: true,
    email: true,
    cedula: true,
    restaurantId: true,
    disabledAt: true,
  } as const;

  if (args.email) {
    return db.diner.findUnique({
      where: { restaurantId_email: { restaurantId: args.restaurantId, email: args.email } },
      select,
    });
  }
  if (args.cedula) {
    return db.diner.findUnique({
      where: { restaurantId_cedula: { restaurantId: args.restaurantId, cedula: args.cedula } },
      select,
    });
  }
  return null;
}
