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
  lowConfidence: boolean;
  ingredient:
    | { kind: "matched"; ingredient: IngredientRef }
    | { kind: "suggest_create"; name: string };
  /** Presentación sugerida si el insumo emparejado ya la tiene con este proveedor. */
  suggestedPresentation: PriceListRef | null;
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
): SupplierMatch {
  const nit = extraction.supplierNit?.replace(/\D/g, "") || null;
  if (nit) {
    const byNit = suppliers.find((s) => (s.nit ?? "").replace(/\D/g, "") === nit);
    if (byNit) return { kind: "matched", supplier: byNit };
  }
  if (extraction.supplierName) {
    const byName = suppliers.find((s) => nameSimilar(s.name, extraction.supplierName!));
    if (byName) return { kind: "matched", supplier: byName };
  }
  return {
    kind: "suggest_create",
    name: extraction.supplierName ?? "",
    nit,
  };
}

function matchLine(
  line: PurchaseInvoiceLineType,
  ingredients: IngredientRef[],
  priceList: PriceListRef[],
  supplierId: string | null,
): LineMatch {
  const ing = ingredients.find((i) => nameSimilar(i.name, line.description));
  const lowConfidence = line.confidence < LOW_CONFIDENCE;
  if (!ing) {
    return {
      line,
      lowConfidence,
      ingredient: { kind: "suggest_create", name: line.description },
      suggestedPresentation: null,
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
};

/** Empareja la factura completa. El total se recomputa desde las líneas. */
export function matchInvoice(
  extraction: PurchaseInvoiceExtraction,
  ctx: MatchContext,
): InvoiceMatch {
  const supplier = matchSupplier(extraction, ctx.suppliers);
  const supplierId = supplier.kind === "matched" ? supplier.supplier.id : null;
  const lines = extraction.lines.map((l) =>
    matchLine(l, ctx.ingredients, ctx.priceList, supplierId),
  );
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
