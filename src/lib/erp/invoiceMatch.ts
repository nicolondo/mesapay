// Emparejamiento de una factura de compra extraída con el catálogo del
// comercio (ERP A2.5) — LÓGICA PURA, sin DB ni IA. El caller precarga
// proveedores, insumos y lista de precios; acá se decide qué está
// emparejado y qué se sugiere crear. Nada se persiste — es insumo de la
// pantalla de revisión.
import type { PurchaseInvoiceExtraction, PurchaseInvoiceLineType } from "@/lib/anthropic";

/** Normaliza para comparar: minúsculas, sin acentos, sin puntuación extra. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Exact supplier aliases intentionally keep punctuation: "1/2 L" and "1.2 L"
 * or distinct supplier SKUs must never collapse into one learned product.
 */
export function normalizeInvoiceAlias(description: string): string {
  return description
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const MAX_INVOICE_ALIAS_LENGTH = 500;

const LOW_CONFIDENCE = 0.7;

export type SupplierRef = { id: string; name: string; nit?: string | null };
export type IngredientRef = {
  id: string;
  name: string;
  measureKind: "mass" | "volume" | "count";
};
/** Presentación de un insumo para un proveedor (lista de precios A0/A2). */
export type PriceListRef = {
  supplierId: string;
  ingredientId: string;
  supplierItemId: string;
  presentationLabel: string;
  contentQty: number;
  lastPriceCents: number | null;
};

export type SupplierMatch =
  | { kind: "matched"; supplier: SupplierRef }
  | { kind: "suggest_create"; name: string; nit: string | null };

export type LineMatch = {
  line: PurchaseInvoiceLineType;
  /** Index in the saved extraction, never the mutable review row position. */
  sourceLineIndex?: number;
  lowConfidence: boolean;
  matchSource?: "alias" | "name";
  /** A remembered target exists but is archived or outside the usable catalog. */
  aliasUnavailable?: boolean;
  ingredient:
    | { kind: "matched"; ingredient: IngredientRef }
    | { kind: "suggest_create"; name: string };
  /** Presentación sugerida si el insumo emparejado ya la tiene con este proveedor. */
  suggestedPresentation: PriceListRef | null;
};

export type InvoiceAliasRef = {
  supplierId: string;
  normalizedDescription: string;
  /** Null retains a blocked alias without exposing an unusable ingredient. */
  ingredientId: string | null;
};

export type InvoiceMatch = {
  supplier: SupplierMatch;
  lines: LineMatch[];
  /** Total recomputado desde las líneas (NO se confía en el total de la factura). */
  computedTotalCents: number;
};

/** Similitud por tokens: 1 si un nombre contiene al otro o comparten todos los tokens del más corto. */
function nameSimilar(a: string, b: string): boolean {
  const fa = fold(a);
  const fb = fold(b);
  if (!fa || !fb) return false;
  if (fa === fb || fa.includes(fb) || fb.includes(fa)) return true;
  const ta = new Set(fa.split(" "));
  const tb = new Set(fb.split(" "));
  const [short, long] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  // Todos los tokens del nombre corto (≥3 chars) presentes en el largo.
  const meaningful = [...short].filter((t) => t.length >= 3);
  if (meaningful.length === 0) return false;
  return meaningful.every((t) => long.has(t));
}

function matchSupplier(
  extraction: PurchaseInvoiceExtraction,
  suppliers: SupplierRef[],
  selectedSupplierId?: string,
): { match: SupplierMatch; aliasSupplierId: string | null } {
  const nit = extraction.supplierNit?.replace(/\D/g, "") || null;
  const unresolved = {
    match: { kind: "suggest_create" as const, name: extraction.supplierName ?? "", nit },
    aliasSupplierId: null,
  };
  const resolved = (supplier: SupplierRef, trusted: boolean) => ({
    match: { kind: "matched" as const, supplier },
    aliasSupplierId: trusted ? supplier.id : null,
  });
  if (selectedSupplierId !== undefined) {
    const selected = suppliers.find((s) => s.id === selectedSupplierId);
    return selected ? resolved(selected, true) : unresolved;
  }
  if (nit) {
    const byNit = suppliers.filter((s) => (s.nit ?? "").replace(/\D/g, "") === nit);
    if (byNit.length) return resolved(byNit[0], byNit.length === 1);
  }
  if (extraction.supplierName) {
    const name = normalizeInvoiceAlias(extraction.supplierName);
    const exact = suppliers.filter((s) => normalizeInvoiceAlias(s.name) === name);
    if (exact.length) {
      const supplierNit = (exact[0].nit ?? "").replace(/\D/g, "");
      return resolved(exact[0], exact.length === 1 && (!nit || !supplierNit || nit === supplierNit));
    }
    const byName = suppliers.find((s) => nameSimilar(s.name, extraction.supplierName!));
    if (byName) return resolved(byName, false);
  }
  return unresolved;
}

function matchLine(
  line: PurchaseInvoiceLineType,
  ingredients: IngredientRef[],
  priceList: PriceListRef[],
  supplierId: string | null,
  alias: InvoiceAliasRef | undefined,
): LineMatch {
  const ing = alias
    ? ingredients.find((i) => i.id === alias.ingredientId)
    : ingredients.find((i) => nameSimilar(i.name, line.description));
  const lowConfidence = line.confidence < LOW_CONFIDENCE;
  if (!ing) {
    return {
      line,
      lowConfidence,
      ingredient: { kind: "suggest_create", name: line.description },
      suggestedPresentation: null,
      ...(alias ? { aliasUnavailable: true } : {}),
    };
  }
  // Presentación del proveedor emparejado para este insumo (si existe).
  const pres =
    supplierId != null
      ? (priceList.find(
          (p) => p.ingredientId === ing.id && p.supplierId === supplierId,
        ) ?? null)
      : null;
  return {
    line,
    lowConfidence,
    matchSource: alias ? "alias" : "name",
    ingredient: { kind: "matched", ingredient: ing },
    suggestedPresentation: pres,
  };
}

/** Total de una línea: el explícito o cantidad × precio unitario (enteros). */
export function lineTotalCents(line: PurchaseInvoiceLineType): number {
  if (line.lineTotalCents != null) return line.lineTotalCents;
  if (line.unitPriceCents != null) {
    return Math.round(line.quantity * line.unitPriceCents);
  }
  return 0;
}

export type MatchContext = {
  suppliers: SupplierRef[];
  ingredients: IngredientRef[];
  priceList: PriceListRef[];
  aliases?: InvoiceAliasRef[];
};

/** Empareja la factura completa. El total se recomputa desde las líneas. */
export function matchInvoice(
  extraction: PurchaseInvoiceExtraction,
  ctx: MatchContext,
  selectedSupplierId?: string,
): InvoiceMatch {
  const { match: supplier, aliasSupplierId } = matchSupplier(extraction, ctx.suppliers, selectedSupplierId);
  const supplierId = supplier.kind === "matched" ? supplier.supplier.id : null;
  const aliases = new Map(
    (ctx.aliases ?? []).filter((alias) => alias.supplierId === aliasSupplierId)
      .map((alias) => [alias.normalizedDescription, alias]),
  );
  const lines = extraction.lines.map((line, sourceLineIndex) => ({
    ...matchLine(line, ctx.ingredients, ctx.priceList, supplierId, aliases.get(normalizeInvoiceAlias(line.description))),
    sourceLineIndex,
  }));
  const computedTotalCents = lines.reduce(
    (a, m) => a + lineTotalCents(m.line),
    0,
  );
  return { supplier, lines, computedTotalCents };
}

/**
 * Sanea la salida de la IA antes de matchear: recorta descripciones,
 * descarta líneas sin descripción / cantidad ≤ 0 / sin ningún precio.
 */
export function normalizeExtraction(
  raw: PurchaseInvoiceExtraction,
): PurchaseInvoiceExtraction {
  const lines = raw.lines
    .map((l) => ({ ...l, description: l.description.trim() }))
    .filter(
      (l) =>
        l.description.length > 0 &&
        l.quantity > 0 &&
        (l.unitPriceCents != null || l.lineTotalCents != null),
    );
  return { ...raw, lines };
}
