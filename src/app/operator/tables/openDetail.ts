/**
 * Qué ficha de mesa está abierta en el Salón (/operator/tables).
 *
 * La ficha (`TableDetailSheet`) se monta UNA sola vez, fuera de las listas
 * de tarjetas. Hace falta porque una mesa ocupada se dibuja dos veces —en
 * «Activas» y otra vez en su sitio de «Todas las mesas»— y, en la vista
 * «Mapa», puede estar en el plano o debajo en «Fuera del mapa». Si la
 * ficha colgara de la aparición que la abrió, bastaba con que la mesa
 * cambiara de aparición entre dos refrescos (se ubica en el plano, o se
 * saca de él) para que la ficha se escondiera con la cuenta todavía
 * abierta. Colgando de la mesa + la cuenta, da igual dónde se tocó.
 *
 * La selección guarda también el `orderId`: cuando esa cuenta termina
 * (se cobró, se canceló) la ficha se va y la selección deja de resolver
 * para siempre. Si colgara sólo de la mesa, al abrirse la SIGUIENTE cuenta
 * en esa misma mesa la ficha reaparecía sola, sin que nadie la tocara.
 */

/**
 * Mesa + cuenta cuya ficha está abierta. La cuenta se fija al abrir (la
 * URL `?open=<tableId>` también la resuelve de entrada), así la selección
 * caduca sola cuando esa cuenta termina.
 */
export type OpenTileRef = { tableId: string; orderId: string };

/** Lo que hace falta de un tile para resolver la ficha abierta. */
export type DetailResolvable = {
  id: string;
  state: "free" | "recently_paid" | "active";
  order?: { id: string } | null;
};

/**
 * La mesa cuya ficha hay que dibujar, o `null` si ya no hay ninguna: la
 * mesa desapareció del salón, su cuenta se cerró, o la mesa abrió otra
 * cuenta distinta de la que se estaba mirando.
 */
export function resolveOpenDetail<T extends DetailResolvable>(
  open: OpenTileRef | null,
  tiles: readonly T[],
): T | null {
  if (!open) return null;
  const tile = tiles.find((t) => t.id === open.tableId);
  if (!tile || tile.state !== "active" || !tile.order) return null;
  if (tile.order.id !== open.orderId) return null;
  return tile;
}
