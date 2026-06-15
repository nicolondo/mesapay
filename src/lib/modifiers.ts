/**
 * Menu modifier helpers.
 *
 * Each menu item can carry an optional list of "modifiers" — choices
 * the diner makes while ordering (size, salsa, addition, etc.). A
 * modifier has a type:
 *
 *   - "radio"    → diner picks exactly one option
 *   - "checkbox" → diner can pick zero or more options
 *
 * Each option carries a label and an optional price delta. Selecting
 * "Camarón +$5.000" adds 5 000 to the dish's effective price. Deltas
 * can be negative (combo discounts) though we cap to ±1 000 000.
 *
 * Persistence: the modifier list lives in MenuItem.modifiers as JSON.
 * Historically opts were just `string[]`. We accept that shape on
 * read via normalizeOpts() so old menus keep working without a data
 * migration; new writes always use the object form.
 *
 * The diner's choice for an order item lives in OrderItem.modifier-
 * Selections as JSON keyed by modifier id:
 *
 *   { [modId]: string }   ← radio (single choice)
 *   { [modId]: string[] } ← checkbox (multi choice)
 *
 * Helpers below normalize both shapes when reading.
 */

export type ModOpt = {
  label: string;
  priceDeltaCents?: number;
};

export type ModifierDef = {
  id: string;
  label: string;
  type: "radio" | "checkbox";
  opts: ModOpt[];
  default?: string;
};

/**
 * Accept either the legacy string[] form or the new object form and
 * return a normalised ModOpt[]. Anything we can't make sense of is
 * dropped — keeps the menu robust against partial corruption.
 */
export function normalizeOpts(raw: unknown): ModOpt[] {
  if (!Array.isArray(raw)) return [];
  const out: ModOpt[] = [];
  for (const o of raw) {
    if (typeof o === "string") {
      const label = o.trim();
      if (label) out.push({ label });
      continue;
    }
    if (o && typeof o === "object" && "label" in o) {
      const label =
        typeof (o as { label: unknown }).label === "string"
          ? ((o as { label: string }).label as string).trim()
          : "";
      if (!label) continue;
      const rawDelta = (o as { priceDeltaCents?: unknown }).priceDeltaCents;
      const priceDeltaCents =
        typeof rawDelta === "number" && Number.isFinite(rawDelta)
          ? Math.trunc(rawDelta)
          : undefined;
      out.push(
        priceDeltaCents !== undefined && priceDeltaCents !== 0
          ? { label, priceDeltaCents }
          : { label },
      );
    }
  }
  return out;
}

/** Normalise a whole modifier definition pulled from JSON. */
export function normalizeModifier(raw: unknown): ModifierDef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  const label = typeof r.label === "string" ? r.label : null;
  const type = r.type === "radio" || r.type === "checkbox" ? r.type : null;
  if (!id || !label || !type) return null;
  const opts = normalizeOpts(r.opts);
  if (opts.length === 0) return null;
  const def: ModifierDef = { id, label, type, opts };
  if (typeof r.default === "string" && r.default.trim()) {
    def.default = r.default;
  }
  return def;
}

/** Normalise a full modifier list, dropping anything malformed. */
export function normalizeModifiers(raw: unknown): ModifierDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeModifier).filter((m): m is ModifierDef => !!m);
}

/**
 * Reassign fresh, unique ids to a list of modifier groups. Used when COPYING
 * a product's modifiers onto OTHER products (bulk action): every item must
 * own its own modifier ids — OrderItem.modifierSelections is keyed by them —
 * and when merging, the appended groups must not collide with the
 * destination's existing ids (`existingIds`).
 *
 * Only the group `id` changes. `default` references an option LABEL (not the
 * group id), so it is preserved untouched.
 */
export function rekeyModifiers(
  mods: ModifierDef[],
  existingIds?: Iterable<string>,
): ModifierDef[] {
  const used = new Set<string>(existingIds ?? []);
  let counter = 0;
  return mods.map((m) => {
    let id: string;
    do {
      counter += 1;
      id = `mod-${counter}`;
    } while (used.has(id));
    used.add(id);
    return { ...m, id };
  });
}

/**
 * Convert a selection record into a flat array of selected option
 * labels in `modifier order`. Used by the kitchen / bar / serve
 * boards to render the chosen options inline.
 *
 * Accepts the historical `Record<string, string>` form (single value
 * per modifier) AND the new `Record<string, string | string[]>` form.
 */
export function flattenSelections(
  raw: unknown,
): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of Object.values(raw as Record<string, unknown>)) {
    if (typeof v === "string") {
      const s = v.trim();
      if (s) out.push(s);
    } else if (Array.isArray(v)) {
      for (const inner of v) {
        if (typeof inner === "string" && inner.trim()) out.push(inner.trim());
      }
    }
  }
  return out;
}

/**
 * Format a selection record into one human-readable string per
 * modifier group, using the menu item's live modifier definitions
 * for the group label.
 *
 *   selections = { "modifier-id-1": ["Carne", "Pollo"], "modifier-id-2": "Fuerte" }
 *   item.modifiers = [{ id: "...-1", label: "Adición", ... }, { id: "...-2", label: "Picante", ... }]
 *
 *   → ["Adición: Carne, Pollo", "Picante: Fuerte"]
 *
 * Iterates the modifier defs (not the keys of selections) so the
 * result preserves the order the diner saw on the dish detail sheet.
 *
 * Falls back to the flat label list when the modifier defs can't be
 * resolved (e.g. the dish was deleted from the menu after the order
 * was placed). Better to show "Carne, Pollo" with no group than to
 * silently drop them.
 */
export function formatItemSelections(
  selections: unknown,
  menuItemModifiers: unknown,
): string[] {
  if (!selections || typeof selections !== "object" || Array.isArray(selections)) {
    return [];
  }
  const mods = normalizeModifiers(menuItemModifiers);
  if (mods.length === 0) {
    return flattenSelections(selections);
  }
  const sel = selections as Record<string, unknown>;
  const out: string[] = [];
  for (const m of mods) {
    const raw = sel[m.id];
    if (raw == null) continue;
    const labels = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
    const cleaned = labels
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (cleaned.length === 0) continue;
    out.push(`${m.label}: ${cleaned.join(", ")}`);
  }
  return out;
}

/**
 * Sum the price deltas of whatever options the diner selected, given
 * the live modifier definition. Unknown labels contribute zero — they
 * might come from a renamed/removed option after the order was placed.
 */
export function computeSelectionsPriceDelta(
  mods: ModifierDef[],
  selections: unknown,
): number {
  if (!selections || typeof selections !== "object") return 0;
  const sel = selections as Record<string, unknown>;
  let total = 0;
  for (const m of mods) {
    const raw = sel[m.id];
    if (raw == null) continue;
    const labels = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
    for (const lab of labels) {
      const opt = m.opts.find((o) => o.label === lab);
      if (opt?.priceDeltaCents) total += opt.priceDeltaCents;
    }
  }
  return total;
}
