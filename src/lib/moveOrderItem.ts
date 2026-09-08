import type { KitchenState, OrderStatus } from "@prisma/client";

/**
 * Reglas puras de "mover UN plato a otra mesa".
 *
 * Viven acá y no dentro del route handler porque son justo la parte que se
 * rompe en silencio: si el gate de cuentas en cobro se relaja,
 * `syncOrderSubtotalFromLiveItems` se niega a tocar la orden (ignora
 * paid/paying) y los subtotales de LAS DOS cuentas quedan mal — nadie se
 * entera hasta el cierre de caja. Como funciones puras se testean sin DB.
 */

export type MoveBlockReason =
  | "item_cancelled"
  | "same_table"
  | "order_closed"
  | "order_paying"
  | "target_order_closed"
  | "target_order_paying";

export type MoveGate = { ok: true } | { ok: false; reason: MoveBlockReason };

/**
 * ¿Se puede mover este plato a la mesa destino?
 *
 * El chequeo de cobro es el importante y va en las DOS puntas:
 *
 * - Origen en `paying`/`paid`: sacarle un plato a una cuenta que ya se está
 *   cobrando descuadra lo que el comensal está pagando en ese momento.
 * - Destino en `paying`/`paid`: sumarle un plato a una cuenta en cobro es
 *   peor todavía — el plato entra pero el subtotal NO se recalcula (la
 *   función canónica ignora esas órdenes), así que el comercio regala la
 *   comida.
 *
 * `targetStatus === null` significa que la mesa destino no tiene cuenta
 * abierta: se le va a crear una, y eso siempre es válido.
 */
export function checkMoveAllowed(input: {
  itemCancelled: boolean;
  sourceStatus: OrderStatus;
  sourceTableId: string;
  targetTableId: string;
  targetStatus: OrderStatus | null;
}): MoveGate {
  if (input.itemCancelled) {
    return { ok: false, reason: "item_cancelled" };
  }
  if (input.sourceTableId === input.targetTableId) {
    return { ok: false, reason: "same_table" };
  }
  if (input.sourceStatus === "paying") {
    return { ok: false, reason: "order_paying" };
  }
  if (input.sourceStatus === "paid" || input.sourceStatus === "cancelled") {
    return { ok: false, reason: "order_closed" };
  }
  if (input.targetStatus === "paying") {
    return { ok: false, reason: "target_order_paying" };
  }
  if (input.targetStatus === "paid" || input.targetStatus === "cancelled") {
    return { ok: false, reason: "target_order_closed" };
  }
  return { ok: true };
}

export type DestinationRoundState = {
  status: OrderStatus;
  kitchenStartedAt: Date | null;
  readyAt: Date | null;
};

/**
 * Estado de la ronda NUEVA que recibe el plato en la mesa destino.
 *
 * El plato conserva intactos su `kitchenStatus`, `preparationStartedAt` y
 * `servedAt` — mover no es re-pedir. La ronda destino se crea reflejando ese
 * estado para que la comanda no se re-dispare: un plato ya listo aterriza en
 * una ronda `ready` (no `placed`), y uno ya entregado en una ronda `served`,
 * que ni siquiera aparece en el tablero de cocina.
 *
 * `readyAt` en el caso `ready` se sella con `now` a propósito: el "listo hace
 * X min" que ve el mesero cuenta desde que el plato quedó listo PARA LA MESA
 * NUEVA, que es el reloj que le importa para ir a entregarlo.
 */
export function destinationRoundState(
  item: {
    kitchenStatus: KitchenState;
    servedAt: Date | null;
    preparationStartedAt: Date | null;
  },
  now: Date,
): DestinationRoundState {
  if (item.servedAt) {
    return {
      status: "served",
      kitchenStartedAt: item.preparationStartedAt,
      readyAt: item.servedAt,
    };
  }
  switch (item.kitchenStatus) {
    case "ready":
      return {
        status: "ready",
        kitchenStartedAt: item.preparationStartedAt,
        readyAt: now,
      };
    case "in_kitchen":
      return {
        status: "in_kitchen",
        // Preservamos el arranque real para que el countdown del bar no se
        // reinicie: el plato lleva cocinándose desde antes del traslado.
        kitchenStartedAt: item.preparationStartedAt ?? now,
        readyAt: null,
      };
    default:
      return { status: "placed", kitchenStartedAt: null, readyAt: null };
  }
}

/** Qué tan avanzada está una orden en el flujo de servicio. */
const SERVICE_RANK: Partial<Record<OrderStatus, number>> = {
  open: 0,
  placed: 1,
  in_kitchen: 2,
  ready: 3,
  served: 4,
};

/**
 * Estado que debe quedar en la orden DESTINO después de recibir el plato, o
 * `null` si no hay que tocarla.
 *
 * `Order.status` es un roll-up del eslabón más débil (mismo criterio que usa
 * el PATCH de order-items para derivar `Round.status` de sus items). Por eso:
 *
 * - Si la orden destino iba más adelante que la ronda entrante (ej: la mesa
 *   ya estaba `served` y le cae un plato `placed`), hay que traerla para
 *   atrás o el Salón muestra la mesa como servida con comida pendiente.
 * - Si iba más atrás, no se toca: otra ronda sigue siendo el eslabón débil.
 * - `open` es el caso especial: significa "todavía no se mandó nada". Deja
 *   de ser cierto en cuanto entra la ronda, así que se alinea siempre.
 *
 * Nunca devuelve algo para órdenes en cobro/cerradas: esas ni llegan acá
 * (checkMoveAllowed las rebota), y pisarles el status sería descuadrar caja.
 */
export function syncedTargetOrderStatus(
  current: OrderStatus,
  incomingRoundStatus: OrderStatus,
): OrderStatus | null {
  if (current === "paying" || current === "paid" || current === "cancelled") {
    return null;
  }
  if (current === "open") {
    return current === incomingRoundStatus ? null : incomingRoundStatus;
  }
  const currentRank = SERVICE_RANK[current];
  const incomingRank = SERVICE_RANK[incomingRoundStatus];
  if (currentRank === undefined || incomingRank === undefined) return null;
  if (currentRank > incomingRank) return incomingRoundStatus;
  return null;
}
