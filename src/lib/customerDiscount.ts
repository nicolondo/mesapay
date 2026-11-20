import type { Prisma } from "@prisma/client";
import { computeDiscountCents } from "./dinerDiscount";
import { lockOrder } from "./orderLock";

/**
 * Descuento comercial fijo de un cliente de facturación (BillingCustomer
 * con `discountEnabled` y `discountBps`, 1000 = 10 %).
 *
 * Se aplica a la cuenta al asociarla al cliente —al cobrar (cualquier
 * medio) o al ligar la factura nominativa a un cliente existente— con el
 * MISMO mecanismo del descuento por comensal: `Order.discountPct` /
 * `Order.discountCents`, que ya alimentan `computeOrderTotals`, el recalc al
 * cambiar el subtotal, la tirilla y la factura. Acá no se duplica nada: se
 * decide el valor y se escribe en esas dos columnas.
 *
 * Guarda además el ORIGEN (`Order.discountBillingCustomerId` y
 * `discountAppliedAt`): la ficha dice «Descuento del cliente X», y el
 * descuento pertenece a ESE cobro — si no se completa (pago rechazado,
 * pantalla abandonada) se deshace con `revertCustomerDiscountInTx`.
 *
 * Límite heredado: `Order.discountPct` es ENTERO. El valor en pesos se
 * calcula exacto con los puntos base; el porcentaje guardado es el
 * redondeado (12,5 % → 13) y es el que usaría un recalc posterior si el
 * subtotal cambiara después de aplicar el descuento.
 */
export type DiscountCustomer = {
  /** El cliente de facturación: queda como ORIGEN del descuento en la cuenta. */
  id: string;
  discountEnabled: boolean;
  discountBps: number;
};

export type ApplyCustomerDiscountResult =
  /** Se aplicó (o ya estaba aplicado el mismo: `changed: false`). */
  | { applied: true; changed: boolean; discountPct: number; discountCents: number; subtotalCents: number }
  | {
      applied: false;
      reason:
        /** El cliente no tiene descuento: no se toca nada. */
        | "no_discount"
        /** La cuenta ya tenía un descuento MAYOR (manual o de comensal): se conserva. */
        | "existing_greater"
        /** Cuenta cerrada, ajena, o con pagos: igual que el descuento por comensal. */
        | "not_applicable";
      discountPct: number | null;
      discountCents: number;
      subtotalCents: number;
    };

/** Porcentaje (con decimales) a partir de puntos base: 1250 → 12.5. */
export function bpsToPct(bps: number): number {
  return bps / 100;
}

/** Valor en pesos del descuento del cliente sobre un subtotal (exacto en bps). */
export function customerDiscountCents(
  subtotalCents: number,
  customer: Pick<DiscountCustomer, "discountEnabled" | "discountBps">,
): number {
  if (!customer.discountEnabled || customer.discountBps <= 0) return 0;
  return computeDiscountCents(subtotalCents, bpsToPct(customer.discountBps));
}

/**
 * Aplica el descuento del cliente a la cuenta, dentro de la transacción del
 * caller (que ya tiene o va a tener el lock de la orden; acá se vuelve a
 * pedir, es reentrante). Idempotente: si el descuento ya está aplicado no
 * escribe. Si la cuenta ya tenía un descuento mayor, se conserva y se avisa.
 */
export async function applyCustomerDiscount(
  tx: Prisma.TransactionClient,
  orderId: string,
  restaurantId: string,
  customer: DiscountCustomer,
): Promise<ApplyCustomerDiscountResult> {
  await lockOrder(tx, orderId);
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      restaurantId: true,
      status: true,
      subtotalCents: true,
      taxCents: true,
      tipCents: true,
      discountPct: true,
      discountCents: true,
    },
  });
  if (!order || order.restaurantId !== restaurantId) {
    return { applied: false, reason: "not_applicable", discountPct: null, discountCents: 0, subtotalCents: 0 };
  }
  const current = {
    discountPct: order.discountPct,
    discountCents: order.discountCents,
    subtotalCents: order.subtotalCents,
  };
  const wanted = customerDiscountCents(order.subtotalCents, customer);
  if (wanted <= 0) return { applied: false, reason: "no_discount", ...current };
  const pct = Math.round(bpsToPct(customer.discountBps));
  if (order.discountCents === wanted && order.discountPct === pct) {
    return { applied: true, changed: false, discountPct: pct, discountCents: wanted, subtotalCents: order.subtotalCents };
  }
  if (order.discountCents > wanted) return { applied: false, reason: "existing_greater", ...current };
  // Misma regla que el descuento por comensal: sobre una cuenta ya cobrada
  // (aunque sea en parte) o con un cobro en vuelo no se cambia lo cobrable.
  if (["paid", "cancelled", "paying"].includes(order.status)) {
    return { applied: false, reason: "not_applicable", ...current };
  }
  if (await tx.payment.count({ where: { orderId, status: { in: ["approved", "pending"] } } })) {
    return { applied: false, reason: "not_applicable", ...current };
  }
  // Ni sobre una cuenta ya facturada (factura antes de cobrar): lo cobrable
  // quedó congelado en la factura — ver `orders/invoicedOrder.ts`.
  if (await tx.simpleInvoice.count({ where: { orderId } })) {
    return { applied: false, reason: "not_applicable", ...current };
  }
  await tx.order.update({
    where: { id: orderId },
    data: {
      discountPct: pct,
      discountCents: wanted,
      totalCents: Math.max(0, order.subtotalCents - wanted) + order.taxCents + order.tipCents,
      // Origen: la ficha dice «Descuento del cliente X» y, si el cobro no se
      // completa, se sabe que este descuento es del cobro y se revierte.
      discountBillingCustomerId: customer.id,
      discountAppliedAt: new Date(),
    },
  });
  return { applied: true, changed: true, discountPct: pct, discountCents: wanted, subtotalCents: order.subtotalCents };
}

export type RevertCustomerDiscountReason =
  /** El pago del cobro quedó rechazado / fallido / cancelado. */
  | "charge_failed"
  /** El personal cerró la pantalla de cobro sin completarlo. */
  | "checkout_abandoned";

export type RevertCustomerDiscountResult =
  | { reverted: true; billingCustomerId: string; discountPct: number | null; discountCents: number }
  | {
      reverted: false;
      reason:
        /** La cuenta no tiene un descuento puesto por un cliente de facturación. */
        | "no_customer_discount"
        /** Cerrada, en cobro, con pagos vivos, facturada, ajena o factura manual. */
        | "not_applicable";
    };

/**
 * Deshace el descuento que puso el paso «Cliente» cuando ESE cobro no se
 * completó (el pago se rechazó o el personal abandonó la pantalla).
 *
 * Sólo toca un descuento cuyo origen es un cliente de facturación
 * (`Order.discountBillingCustomerId`): el del comensal identificado, uno
 * sin origen (cuentas viejas) o cualquier otro, NUNCA. Mismas guardas que
 * «Quitar descuento» (`removeOrderDiscount`): cuenta no pagada / en cobro /
 * cancelada, sin pagos aprobados ni pendientes (cobro parcial o mixto: lo
 * cobrado ya llevó el descuento) y sin factura emitida (lo cobrable quedó
 * congelado en ella). Tampoco en una factura manual: ahí el cliente es el
 * de la factura, no el de un cobro en mesa.
 *
 * Idempotente: sin descuento del cliente no escribe nada. Dentro de la
 * transacción del caller; pide el lock de la orden (reentrante). Deja
 * rastro en la auditoría (`order.customer_discount_reverted`).
 */
export async function revertCustomerDiscountInTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  opts: {
    reason: RevertCustomerDiscountReason;
    /** Sólo para acotar al comercio de la sesión (abandono desde el cliente). */
    restaurantId?: string;
    actor?: { userId: string; email: string; role: string } | null;
  },
): Promise<RevertCustomerDiscountResult> {
  await lockOrder(tx, orderId);
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      restaurantId: true,
      status: true,
      subtotalCents: true,
      taxCents: true,
      tipCents: true,
      discountPct: true,
      discountCents: true,
      discountBillingCustomerId: true,
      table: { select: { kind: true } },
    },
  });
  if (!order || (opts.restaurantId && order.restaurantId !== opts.restaurantId)) {
    return { reverted: false, reason: "not_applicable" };
  }
  const billingCustomerId = order.discountBillingCustomerId;
  if (!billingCustomerId) return { reverted: false, reason: "no_customer_discount" };
  if (order.table?.kind === "manual") return { reverted: false, reason: "not_applicable" };
  if (["paid", "cancelled", "paying"].includes(order.status)) {
    return { reverted: false, reason: "not_applicable" };
  }
  if (await tx.payment.count({ where: { orderId, status: { in: ["approved", "pending"] } } })) {
    return { reverted: false, reason: "not_applicable" };
  }
  if (await tx.simpleInvoice.count({ where: { orderId } })) {
    return { reverted: false, reason: "not_applicable" };
  }
  await tx.order.update({
    where: { id: orderId },
    data: {
      discountPct: null,
      discountCents: 0,
      discountBillingCustomerId: null,
      discountAppliedAt: null,
      totalCents: order.subtotalCents + order.taxCents + order.tipCents,
    },
  });
  await tx.auditEvent.create({
    data: {
      restaurantId: order.restaurantId,
      actorUserId: opts.actor?.userId ?? null,
      actorEmail: opts.actor?.email ?? "system",
      actorRole: opts.actor?.role ?? "system",
      kind: "order.customer_discount_reverted",
      targetType: "order",
      targetId: orderId,
      summary: `order.customer_discount_reverted ${opts.reason}`,
      diff: {
        reason: opts.reason,
        billingCustomerId,
        discountPct: order.discountPct,
        discountCents: order.discountCents,
      },
    },
  });
  return {
    reverted: true,
    billingCustomerId,
    discountPct: order.discountPct,
    discountCents: order.discountCents,
  };
}
