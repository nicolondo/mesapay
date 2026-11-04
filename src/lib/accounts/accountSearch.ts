// Búsqueda de cuentas del PUC para el autocompletado (AccountCombobox) —
// LÓGICA PURA, sin DB ni red, segura en el navegador. Mismo patrón que la
// búsqueda de proveedores (`@/lib/suppliers/supplierSearch`): la lista llega
// precargada (un plan de cuentas tiene cientos de cuentas, no miles) y se
// filtra en memoria. El teclado del combobox es el mismo
// (`comboboxKeyAction`).
import { foldSearchText, MATCH_TIER } from "@/lib/suppliers/supplierSearch";

export type AccountSearchItem = { code: string; name: string };

/**
 * Nivel de coincidencia de una cuenta con la búsqueda (menor = mejor), o
 * null si no coincide. Sin acentos ni mayúsculas.
 *
 *  · Los números son PREFIJO del código: «5135» encuentra 513505, 513525…;
 *    el código exacto es el mejor nivel.
 *  · Las palabras van contra el nombre: empieza igual, inicio de palabra,
 *    o «contiene».
 *  · Mezclado («5135 agua»): todas las partes tienen que calzar; el nivel es
 *    el peor de las dos.
 */
export function accountMatchTier(item: AccountSearchItem, query: string): number | null {
  const needle = foldSearchText(query);
  if (!needle) return null;
  const tokens = needle.split(" ");
  const nums = tokens.filter((t) => /^\d+$/.test(t));
  const words = tokens.filter((t) => !/^\d+$/.test(t));
  let tier: number = MATCH_TIER.exact;
  for (const n of nums) {
    if (item.code === n) continue;
    if (!item.code.startsWith(n)) return null;
    tier = Math.max(tier, MATCH_TIER.prefix);
  }
  if (words.length > 0) {
    const name = foldSearchText(item.name);
    const text = words.join(" ");
    const nameWords = name.split(" ");
    let t: number | null = null;
    if (name === text) t = MATCH_TIER.exact;
    else if (name.startsWith(text)) t = MATCH_TIER.prefix;
    else if (words.every((w) => nameWords.some((nw) => nw.startsWith(w)))) t = MATCH_TIER.wordStart;
    else if (words.every((w) => name.includes(w))) t = MATCH_TIER.contains;
    if (t === null) return null;
    tier = Math.max(tier, t);
  }
  return tier;
}

/**
 * Filtra y ordena cuentas: con búsqueda, sólo las que coinciden (mejor
 * nivel primero y, a igual nivel, por código); sin búsqueda, todas por
 * código.
 */
export function rankAccounts<T extends AccountSearchItem>(
  items: readonly T[],
  query: string,
  opts: { limit?: number } = {},
): T[] {
  const hasQuery = foldSearchText(query) !== "";
  const scored: { item: T; tier: number }[] = [];
  for (const item of items) {
    if (!hasQuery) {
      scored.push({ item, tier: 0 });
      continue;
    }
    const tier = accountMatchTier(item, query);
    if (tier !== null) scored.push({ item, tier });
  }
  scored.sort((a, b) => a.tier - b.tier || a.item.code.localeCompare(b.item.code));
  const out = scored.map((s) => s.item);
  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}

/** «513505 · Acueducto y alcantarillado»: como se muestra una cuenta elegida. */
export function accountLabel(a: AccountSearchItem): string {
  return `${a.code} · ${a.name}`;
}

/**
 * Cuenta que lo escrito identifica sin ambigüedad (código exacto, o
 * «código · nombre» completo), para resolver al salir del campo sin haber
 * elegido de la lista.
 */
export function exactAccount<T extends AccountSearchItem>(items: readonly T[], text: string): T | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const byCode = items.find((a) => a.code === trimmed);
  if (byCode) return byCode;
  const folded = foldSearchText(trimmed);
  const hits = items.filter((a) => foldSearchText(accountLabel(a)) === folded);
  return hits.length === 1 ? hits[0]! : null;
}
