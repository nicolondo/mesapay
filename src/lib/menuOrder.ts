/**
 * Orden de los platos dentro de cada categoría de la carta.
 *
 * El dueño pidió "los platos quiero que estén en orden alfabético", así que
 * ése es el default (`Restaurant.menuItemOrder = "alphabetical"`). Quien
 * prefiera armar la carta a mano elige `"manual"` en el editor de la carta y
 * ahí puede mover cada plato (arrastrando o con Subir/Bajar); ese orden vive
 * en `MenuItem.sortOrder`.
 *
 * Lo usan la carta del comensal (mesa y para llevar), la carta del mesero y
 * del operador para montar pedidos (incluida la factura manual) y el editor
 * de la carta. Las CATEGORÍAS no pasan por acá: conservan su propio orden.
 *
 * Todo es puro (sin DB ni React) para poder testearlo y usarlo igual en el
 * server y en el cliente.
 */

export const MENU_ITEM_ORDERS = ["alphabetical", "manual"] as const;
export type MenuItemOrder = (typeof MENU_ITEM_ORDERS)[number];
export const DEFAULT_MENU_ITEM_ORDER: MenuItemOrder = "alphabetical";

export function isMenuItemOrder(value: unknown): value is MenuItemOrder {
  return (
    typeof value === "string" &&
    (MENU_ITEM_ORDERS as readonly string[]).includes(value)
  );
}

/**
 * Lo que venga de la base (es un TEXT) → un modo válido. Cualquier valor
 * desconocido cae al default en vez de romper la carta.
 */
export function normalizeMenuItemOrder(value: unknown): MenuItemOrder {
  return isMenuItemOrder(value) ? value : DEFAULT_MENU_ITEM_ORDER;
}

/**
 * Clave de orden alfabético: el nombre sin los signos del principio. Así
 * "¡Picada!" queda en la P y "\"Especial\" de la casa" en la E, no todos
 * amontonados al comienzo de la lista. Si el nombre no tiene ni una letra ni
 * un número (raro), se usa tal cual.
 */
function alphaKey(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed.replace(/^[^\p{L}\p{N}]+/u, "");
  return stripped || trimmed;
}

const collators = new Map<string, Intl.Collator>();
function collatorFor(locale: string): Intl.Collator {
  let c = collators.get(locale);
  if (!c) {
    // sensitivity "base": ni tildes ni mayúsculas importan ("Ají" junto a
    // "aji"). numeric: "Plato 2" antes de "Plato 10".
    c = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
    collators.set(locale, c);
  }
  return c;
}

/**
 * Devuelve una COPIA de `items` en el orden del modo pedido.
 *
 * - `alphabetical`: orden natural por `name` en el idioma `locale` (el
 *   nombre que efectivamente se muestra: si la carta está traducida, se
 *   ordena por la traducción). Los empates (mismo nombre salvo tildes o
 *   mayúsculas) conservan el orden de entrada.
 * - `manual`: por `sortOrder` ascendente, la posición que se arma en el
 *   editor. Los empates conservan el orden de entrada (las consultas ya
 *   desempatan por fecha de creación e id).
 *
 * Es estable: `Array.prototype.sort` lo es desde ES2019.
 */
export function sortMenuItems<T extends { name: string; sortOrder?: number }>(
  items: readonly T[],
  mode: MenuItemOrder,
  locale: string,
): T[] {
  const out = [...items];
  if (mode === "manual") {
    return out.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }
  const collator = collatorFor(locale);
  const keys = new Map<T, string>(out.map((it) => [it, alphaKey(it.name)]));
  return out.sort((a, b) => collator.compare(keys.get(a)!, keys.get(b)!));
}

/*
 * ---------------------------------------------------------------------
 * Reordenamiento manual (editor de la carta)
 * ---------------------------------------------------------------------
 */

/** Separación entre posiciones al reescribir el orden de una categoría. */
export const POSITION_STEP = 10;

/**
 * Posición (`sortOrder`) de cada plato según su lugar en la lista:
 * 10, 20, 30… Deja huecos, igual que el alta de un plato (último + 10).
 */
export function positionsFor(orderedIds: readonly string[]): Map<string, number> {
  return new Map(orderedIds.map((id, i) => [id, (i + 1) * POSITION_STEP]));
}

/**
 * Mueve el elemento de `from` para que quede en el índice `to` de la lista
 * resultante. Índices fuera de rango se acotan; si no hay nada que mover
 * devuelve una copia igual.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  if (target === from) return out;
  const [moved] = out.splice(from, 1);
  out.splice(target, 0, moved);
  return out;
}

/**
 * Botones Subir/Bajar: corre el elemento de `index` un lugar. En los
 * extremos (subir el primero, bajar el último) no cambia nada.
 */
export function stepItem<T>(
  list: readonly T[],
  index: number,
  dir: "up" | "down",
): T[] {
  return moveItem(list, index, dir === "up" ? index - 1 : index + 1);
}

/**
 * Arrastrar y soltar: `slot` es el hueco donde se suelta, contado sobre la
 * lista ANTES de mover (0 = antes del primero, `length` = después del
 * último). Soltar en el propio hueco o en el de al lado no cambia nada.
 */
export function moveToSlot<T>(list: readonly T[], from: number, slot: number): T[] {
  const s = Math.max(0, Math.min(list.length, slot));
  return moveItem(list, from, s > from ? s - 1 : s);
}
