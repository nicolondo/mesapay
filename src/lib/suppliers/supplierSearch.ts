// Búsqueda de proveedores para el autocompletado (SupplierCombobox) —
// LÓGICA PURA, sin DB ni red, segura en el navegador. Filtra y ordena una
// lista ya precargada: un comercio tiene decenas o pocos cientos de
// proveedores, así que buscar en memoria es instantáneo y no hace falta
// un endpoint de búsqueda.
import { computeNitDv } from "@/lib/erp/exogena";

export type SupplierSearchItem = {
  id: string;
  name: string;
  /** NIT/documento tal como se guardó: con o sin puntos, guion o DV. */
  taxId?: string | null;
  /** Otros nombres con los que se conoce al proveedor (razón social, sigla…). */
  aliases?: readonly string[] | null;
};

/**
 * Niveles de coincidencia, de mejor a peor. Los alias puntúan medio nivel
 * por debajo del nombre para que, a igual calidad, gane el nombre visible.
 */
export const MATCH_TIER = {
  exact: 0,
  prefix: 1,
  wordStart: 2,
  contains: 3,
} as const;

const ALIAS_PENALTY = 0.5;

/** Minúsculas, sin acentos y con la puntuación convertida en espacios. */
export function foldSearchText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ¿La búsqueda es un NIT? Sólo dígitos, admitiendo puntos, guiones y
 * espacios ("900.123.456-7"). Devuelve las variantes en dígitos: completa
 * y, si trae guion antes del último dígito, también la base sin el DV.
 */
function nitQueryKeys(query: string): string[] | null {
  const trimmed = query.trim();
  if (!/^[\d.\-\s]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 2) return null;
  const keys = [digits];
  const withDv = /^([\d.\s]+)-\s*(\d)$/.exec(trimmed);
  if (withDv) keys.push(withDv[1]!.replace(/\D/g, ""));
  return keys;
}

/**
 * Variantes en dígitos de un NIT guardado, para que coincida se escriba
 * con o sin DV: los dígitos tal cual, la base sin DV (si se guardó con
 * guion, o si el último dígito es justamente el DV de los anteriores) y
 * la base con su DV calculado (si se guardó sin DV).
 */
export function taxIdKeys(taxId: string | null | undefined): string[] {
  if (!taxId) return [];
  const all = taxId.replace(/\D/g, "");
  if (!all) return [];
  const keys = new Set<string>([all]);
  const dashed = /^(.*\d)\s*-\s*(\d)\s*$/.exec(taxId.trim());
  let base = all;
  if (dashed) {
    base = dashed[1]!.replace(/\D/g, "");
    keys.add(base);
  } else if (all.length >= 7 && computeNitDv(all.slice(0, -1)) === all.slice(-1)) {
    // "9001234567": el último dígito cuadra como DV → también vale sin él.
    keys.add(all.slice(0, -1));
  }
  const dv = computeNitDv(base);
  if (dv !== null) keys.add(base + dv);
  return [...keys];
}

function textTier(haystack: string, needle: string, tokens: string[]): number | null {
  if (!haystack) return null;
  if (haystack === needle) return MATCH_TIER.exact;
  if (haystack.startsWith(needle)) return MATCH_TIER.prefix;
  const words = haystack.split(" ");
  if (tokens.every((tok) => words.some((w) => w.startsWith(tok)))) {
    return MATCH_TIER.wordStart;
  }
  if (haystack.includes(needle)) return MATCH_TIER.contains;
  // "donpollo" encuentra "Don Pollo" y viceversa.
  if (haystack.replace(/ /g, "").includes(needle.replace(/ /g, ""))) {
    return MATCH_TIER.contains;
  }
  if (tokens.length > 1 && tokens.every((tok) => haystack.includes(tok))) {
    return MATCH_TIER.contains;
  }
  return null;
}

function nitTier(taxId: string | null | undefined, queryKeys: string[]): number | null {
  const keys = taxIdKeys(taxId);
  if (keys.length === 0) return null;
  if (queryKeys.some((q) => keys.includes(q))) return MATCH_TIER.exact;
  const full = queryKeys[0]!;
  if (keys.some((k) => k.startsWith(full))) return MATCH_TIER.prefix;
  if (full.length >= 4 && keys.some((k) => k.includes(full))) return MATCH_TIER.contains;
  return null;
}

/**
 * Nivel de coincidencia de un proveedor con la búsqueda (menor = mejor),
 * o null si no coincide. Busca por nombre, alias y NIT.
 */
export function supplierMatchTier(item: SupplierSearchItem, query: string): number | null {
  const needle = foldSearchText(query);
  if (!needle) return null;
  const tokens = needle.split(" ");
  let best: number | null = textTier(foldSearchText(item.name), needle, tokens);
  for (const alias of item.aliases ?? []) {
    const tier = textTier(foldSearchText(alias), needle, tokens);
    if (tier !== null && (best === null || tier + ALIAS_PENALTY < best)) {
      best = tier + ALIAS_PENALTY;
    }
  }
  const nitKeys = nitQueryKeys(query);
  if (nitKeys) {
    const tier = nitTier(item.taxId, nitKeys);
    if (tier !== null && (best === null || tier < best)) best = tier;
  }
  return best;
}

const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });

/**
 * Filtra y ordena proveedores para mostrar en el autocompletado.
 *
 * - Con búsqueda: sólo los que coinciden; primero exactos, luego los que
 *   empiezan igual, luego inicio de palabra, luego "contiene". A igual
 *   nivel, los usados recientemente primero y después alfabético.
 * - Sin búsqueda: los recientes (en orden de uso) y luego el resto en
 *   orden alfabético.
 */
export function rankSuppliers<T extends SupplierSearchItem>(
  items: readonly T[],
  query: string,
  opts: { recentIds?: readonly string[]; limit?: number } = {},
): T[] {
  const recent = new Map<string, number>();
  (opts.recentIds ?? []).forEach((id, i) => {
    if (!recent.has(id)) recent.set(id, i);
  });
  const recency = (id: string) => recent.get(id) ?? Number.POSITIVE_INFINITY;
  const hasQuery = foldSearchText(query) !== "";

  const scored: { item: T; tier: number }[] = [];
  for (const item of items) {
    if (!hasQuery) {
      scored.push({ item, tier: 0 });
      continue;
    }
    const tier = supplierMatchTier(item, query);
    if (tier !== null) scored.push({ item, tier });
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      recency(a.item.id) - recency(b.item.id) ||
      collator.compare(a.item.name, b.item.name),
  );
  const out = scored.map((s) => s.item);
  return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
}

/**
 * Proveedor cuyo nombre coincide exactamente con lo escrito (sin acentos
 * ni mayúsculas), si hay uno solo. Sirve para resolver al salir del campo
 * sin haber elegido de la lista.
 */
export function exactSupplierByName<T extends SupplierSearchItem>(
  items: readonly T[],
  text: string,
): T | null {
  const needle = foldSearchText(text);
  if (!needle) return null;
  const hits = items.filter((s) => foldSearchText(s.name) === needle);
  return hits.length === 1 ? hits[0]! : null;
}

/* ───────────── Teclado del combobox (patrón WAI-ARIA) ─────────────
   Pura para poder probarla sin DOM: el componente sólo aplica lo que
   devuelve. Las opciones son [proveedores..., crear?]. */

export type ComboboxKeyInput = {
  key: string;
  open: boolean;
  /** Índice activo (resaltado) o -1. */
  active: number;
  optionCount: number;
  /** Índice de la opción «Crear proveedor», o -1 si no hay. */
  createIndex: number;
  /** ¿El operador escribió algo desde la última selección? */
  typed: boolean;
};

export type ComboboxKeyAction =
  | { kind: "none" }
  | { kind: "open"; active: number }
  | { kind: "move"; active: number }
  | { kind: "pick"; index: number }
  | { kind: "close" }
  | { kind: "clearText" };

/** Qué hacer con una tecla y si hay que prevenir su efecto por defecto. */
export function comboboxKeyAction(
  input: ComboboxKeyInput,
): { action: ComboboxKeyAction; preventDefault: boolean } {
  const { key, open, active, optionCount, createIndex, typed } = input;
  const valid = active >= 0 && active < optionCount;
  switch (key) {
    case "ArrowDown":
      if (!open) return { action: { kind: "open", active: optionCount > 0 ? 0 : -1 }, preventDefault: true };
      if (optionCount === 0) return { action: { kind: "none" }, preventDefault: true };
      return { action: { kind: "move", active: valid ? (active + 1) % optionCount : 0 }, preventDefault: true };
    case "ArrowUp":
      if (!open) return { action: { kind: "open", active: optionCount - 1 }, preventDefault: true };
      if (optionCount === 0) return { action: { kind: "none" }, preventDefault: true };
      return {
        action: { kind: "move", active: valid ? (active - 1 + optionCount) % optionCount : optionCount - 1 },
        preventDefault: true,
      };
    case "Enter":
      // Con la lista abierta, Enter nunca envía el formulario.
      if (!open) return { action: { kind: "none" }, preventDefault: false };
      return { action: valid ? { kind: "pick", index: active } : { kind: "close" }, preventDefault: true };
    case "Escape":
      if (open) return { action: { kind: "close" }, preventDefault: true };
      if (typed) return { action: { kind: "clearText" }, preventDefault: true };
      return { action: { kind: "none" }, preventDefault: false };
    case "Tab":
      // Tab acepta el proveedor resaltado y deja seguir al siguiente campo;
      // nunca dispara «Crear» (abriría un formulario sin pedirlo).
      if (!open) return { action: { kind: "none" }, preventDefault: false };
      if (typed && valid && active !== createIndex) {
        return { action: { kind: "pick", index: active }, preventDefault: false };
      }
      return { action: { kind: "close" }, preventDefault: false };
    default:
      return { action: { kind: "none" }, preventDefault: false };
  }
}
