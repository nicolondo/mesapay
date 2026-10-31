/**
 * «Servir todo» del tablero de cocina / bar: reglas PURAS compartidas por el
 * tablero (cliente) y por `POST /api/operator/order-items/serve-all`.
 *
 * Sin imports de servidor a propósito: el tablero es un Client Component y
 * los tests de vitest corren en `node` sin base de datos.
 */

export type ServeAllStation = "kitchen" | "bar";

/** Estados de ronda que el tablero muestra (las páginas filtran por esto). */
export const SERVE_ALL_ROUND_STATUSES = ["placed", "in_kitchen", "ready"] as const;

/** Tope de ids por llamada: un tablero lleno no pasa de unos cientos. */
export const SERVE_ALL_MAX_ITEMS = 1000;

/**
 * Roles que pueden «Servir todo»: SOLO la administración del comercio
 * (`operator`, `group_admin` y `platform_admin`, que entran impersonando).
 * Es el mismo conjunto que `OPERATOR_ROLES` de `src/lib/staffAccess.ts`, que
 * no se puede importar acá porque arrastra la sesión del servidor (un test
 * verifica que no se separen). Cocina, bar, mesero y terminal siguen
 * sirviendo plato por plato, pero no vacían el tablero de un toque.
 */
const SERVE_ALL_ROLES: ReadonlySet<string> = new Set([
  "operator",
  "group_admin",
  "platform_admin",
]);

export function canServeAll(role: string | null | undefined): boolean {
  return !!role && SERVE_ALL_ROLES.has(role);
}

// ── Lado del tablero ─────────────────────────────────────────────────────

/** Lo mínimo de una ronda del tablero que hace falta para armar la lista. */
export type ServeAllBoardRound = {
  order: { id: string; tableNumber: number; orderType: "dineIn" | "pickup" };
  items: { id: string; servedAt: string | null }[];
};

export type ServeAllTargets = {
  /** Ids a servir, en el orden del tablero y sin repetidos. */
  itemIds: string[];
  /** Pedidos distintos a los que pertenecen. */
  orderCount: number;
  /** Mesas distintas (sólo pedidos en mesa). */
  tableCount: number;
  /** Algún pedido es para recoger: se habla de "pedidos", no de "mesas". */
  hasPickup: boolean;
};

/**
 * Lo pendiente que el tablero tiene A LA VISTA: cada ítem no servido de las
 * rondas que recibió la página. Las rondas ya llegan filtradas por estación
 * y, en el bar, por la sub-estación activa (ver las páginas de cocina y
 * bar), así que esto no vuelve a filtrar por estación: sólo saca lo ya
 * servido y lo que se está sirviendo en este momento (`pendingServed`, el
 * servido optimista de un toque individual que todavía no volvió).
 */
export function collectServeAllTargets(
  rounds: readonly ServeAllBoardRound[],
  pendingServed: ReadonlySet<string> = new Set(),
): ServeAllTargets {
  const itemIds: string[] = [];
  const seen = new Set<string>();
  const orders = new Set<string>();
  const tables = new Set<number>();
  let hasPickup = false;
  for (const round of rounds) {
    let roundHasTarget = false;
    for (const item of round.items) {
      if (item.servedAt || pendingServed.has(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      itemIds.push(item.id);
      roundHasTarget = true;
    }
    if (!roundHasTarget) continue;
    orders.add(round.order.id);
    if (round.order.orderType === "pickup") hasPickup = true;
    else tables.add(round.order.tableNumber);
  }
  return { itemIds, orderCount: orders.size, tableCount: tables.size, hasPickup };
}

export type ServeAllRequestBody = {
  station: ServeAllStation;
  barSubStation: string | null;
  itemIds: string[];
};

/**
 * Cuerpo del POST. La sub-estación sólo viaja desde el bar: en cocina no
 * existe, y mandarla haría que el servidor no encontrara nada.
 */
export function buildServeAllRequest(
  station: ServeAllStation,
  barSubStation: string | null | undefined,
  itemIds: readonly string[],
): ServeAllRequestBody {
  return {
    station,
    barSubStation: station === "bar" ? barSubStation || null : null,
    itemIds: [...itemIds],
  };
}

// ── Lado del servidor ────────────────────────────────────────────────────

/** La fila de OrderItem que lee el endpoint para decidir si la sirve. */
export type ServeAllCandidate = {
  id: string;
  orderId: string;
  roundId: string | null;
  station: string;
  servedAt: Date | null;
  cancelledAt: Date | null;
  order: { restaurantId: string };
  round: { status: string } | null;
  menuItem: { category: { barSubStation: string | null } | null } | null;
};

export type ServeAllScope = {
  restaurantId: string;
  station: ServeAllStation;
  barSubStation: string | null;
};

/**
 * ¿El endpoint puede servir este ítem? Exactamente lo que el tablero
 * muestra como pendiente, y nada de afuera:
 *   - del comercio activo (nunca de otro comercio);
 *   - de ESTA estación;
 *   - ni servido ni cancelado (una cortesía / "no cobrar" también queda
 *     con `cancelledAt` y se ignora);
 *   - en una ronda viva del tablero (placed / in_kitchen / ready);
 *   - en el bar con sub-estación activa: la sub-estación ACTUAL de la
 *     categoría del plato, igual que filtra la página del bar (no el
 *     snapshot `OrderItem.barSubStation`).
 */
export function isServeAllCandidate(item: ServeAllCandidate, scope: ServeAllScope): boolean {
  if (item.order.restaurantId !== scope.restaurantId) return false;
  if (item.station !== scope.station) return false;
  if (item.servedAt || item.cancelledAt) return false;
  if (!item.roundId || !item.round) return false;
  if (!(SERVE_ALL_ROUND_STATUSES as readonly string[]).includes(item.round.status)) return false;
  if (scope.station === "bar" && scope.barSubStation) {
    if (item.menuItem?.category?.barSubStation !== scope.barSubStation) return false;
  }
  return true;
}
