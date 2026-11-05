import { describe, expect, it } from "vitest";
import {
  discountAmountCents,
  parseDiscountInput,
  persistedOrderDiscounts,
  resolveOrderDiscounts,
  toPersistedDiscount,
} from "@/lib/erp/purchaseDiscount";
import { lineIncCents } from "@/lib/erp/purchaseLineTax";
import { referenceLineCost } from "@/lib/erp/ingredientPrice";
import type { SupplierHistoryItem } from "@/lib/erp/supplierHistory";
import {
  blankLine,
  buildCreateOrderPayload,
  changeUnit,
  computedLineCents,
  dateInputToIso,
  detachLine,
  draftTotals,
  duplicateOf,
  effectiveUnitCents,
  exactOption,
  gridKeyAction,
  ingredientOptions,
  insertBlankAfter,
  isBlankLine,
  lineIssues,
  lineListCents,
  lineQtyBase,
  linesForIngredients,
  mergeLines,
  nextKey,
  parsePesos,
  parseQty,
  pickIngredient,
  PRES,
  rankOptions,
  removeLine,
  resolveLine,
  resolveLines,
  suggestPrice,
  type GridKeyInput,
  type OcCatalog,
  type OcIngredient,
  type OcLine,
  type OcSupplierItem,
  type ResolvedOcLine,
} from "./draft";

/* ───────────────────────────── Datos ───────────────────────────────── */

const rice: OcIngredient = { id: "rice", name: "Arroz blanco", measureKind: "mass", referencePriceCents: 450_000 };
const beef: OcIngredient = { id: "beef", name: "Lomo de res", measureKind: "mass", referencePriceCents: 4_200_000 };
const oil: OcIngredient = { id: "oil", name: "Aceite vegetal", measureKind: "volume", referencePriceCents: null };
const eggs: OcIngredient = { id: "eggs", name: "Huevo AA", measureKind: "count", referencePriceCents: 60_000 };
const sugar: OcIngredient = { id: "sugar", name: "Azúcar", measureKind: "mass", referencePriceCents: 400_000 };

const sack: OcSupplierItem = { id: "si-beef", presentationLabel: "Bulto 50 kg", contentQty: 50_000, lastPriceCents: 18_000_000, ingredient: beef };
const tray: OcSupplierItem = { id: "si-eggs", presentationLabel: "Panal × 30", contentQty: 30_000, lastPriceCents: null, ingredient: eggs };

const hist = (h: Partial<SupplierHistoryItem> & { ingredientId: string }): SupplierHistoryItem => ({
  orders: 1,
  lastOrderedAt: "2026-10-20T15:00:00.000Z",
  supplierItemId: null,
  presentations: null,
  qtyBase: 1000,
  listCostCents: 0,
  taxPct: 0,
  incPct: null,
  ...h,
});

const catalog: OcCatalog = {
  priceList: [sack, tray],
  ingredients: [rice, beef, oil, eggs, sugar],
  history: [
    hist({ ingredientId: "rice", orders: 5, qtyBase: 500, listCostCents: 225_000, taxPct: 5 }),
    hist({ ingredientId: "oil", orders: 2, qtyBase: 3000, listCostCents: 2_700_000, taxPct: 19, incPct: 8 }),
    hist({ ingredientId: "eggs", orders: 3, supplierItemId: "si-eggs", presentations: 4, qtyBase: 120_000, listCostCents: 7_200_000 }),
  ],
};

const picked = (ing: OcIngredient, patch: Partial<OcLine> = {}, key = 1): OcLine => ({
  ...pickIngredient(blankLine(key), ing, catalog),
  ...patch,
});

/* ───────────────────────── Números y unidades ──────────────────────── */

describe("números del formulario", () => {
  it("lee cantidades con coma o punto y rechaza vacío, cero y basura", () => {
    expect(parseQty("2,5")).toBe(2.5);
    expect(parseQty("2.5")).toBe(2.5);
    expect(parseQty("")).toBeNull();
    expect(parseQty("0")).toBeNull();
    expect(parseQty("abc")).toBeNull();
  });

  it("lee pesos sin agrupar (MoneyInput) a centavos y acepta cero", () => {
    expect(parsePesos("4500.5")).toBe(450_050);
    expect(parsePesos("0")).toBe(0);
    expect(parsePesos("")).toBeNull();
    expect(parsePesos("-3")).toBeNull();
  });

  it("presentaciones: entero × contenido; suelta: a la unidad base", () => {
    expect(lineQtyBase(picked(beef, { qtyRaw: "2" }))).toBe(100_000);
    expect(lineQtyBase(picked(beef, { qtyRaw: "1,5" }))).toBeNull();
    expect(lineQtyBase(picked(rice, { qtyRaw: "2,5" }))).toBe(2500);
    expect(lineQtyBase(picked(rice, { qtyRaw: "1,5", unit: "g" }))).toBeNull();
    expect(lineQtyBase(picked(eggs, { qtyRaw: "12", unit: "un" }))).toBe(12_000);
  });

  it("total = presentaciones × precio, o cantidad × precio por kg/L/un (mismo redondeo que el precio de referencia)", () => {
    expect(computedLineCents(picked(beef, { qtyRaw: "2" }))).toBe(36_000_000);
    const loose = picked(rice, { qtyRaw: "2,5", priceRaw: "25000.75" });
    expect(computedLineCents(loose)).toBe(referenceLineCost(2_500_075, 2500));
    expect(computedLineCents(picked(rice, { qtyRaw: "500", unit: "g", priceRaw: "4500" }))).toBe(225_000);
  });

  it("el total escrito a mano manda y el precio unitario sale de él", () => {
    const l = picked(rice, { qtyRaw: "3", priceRaw: "25000", totalRaw: "60000" });
    expect(lineListCents(l)).toBe(6_000_000);
    expect(effectiveUnitCents(l)).toBe(2_000_000);
    const pres = picked(beef, { qtyRaw: "2", totalRaw: "350000" });
    expect(effectiveUnitCents(pres)).toBe(17_500_000);
  });
});

/* ─────────────────── Precio y presentación recordados ──────────────── */

describe("elegir el insumo recuerda lo de este proveedor", () => {
  it("con presentación en la lista de precios: en presentaciones, 1, con el último precio", () => {
    const l = pickIngredient(blankLine(1), beef, catalog);
    expect(l).toMatchObject({ unit: PRES, qtyRaw: "1", priceRaw: "180000", priceSource: "list", supplierItem: { id: "si-beef" } });
  });

  it("pedido suelto antes: en kg (aunque fueran 500 g), con la cantidad, el precio por kg y el IVA de la última vez", () => {
    const l = pickIngredient(blankLine(1), rice, catalog);
    expect(l).toMatchObject({ unit: "kg", qtyRaw: "0,5", priceRaw: "4500", priceSource: "history", tax: { ivaPct: 5, inc: false } });
  });

  it("recuerda el impuesto al consumo de la última línea", () => {
    const l = pickIngredient(blankLine(1), oil, catalog, { dec: ".", step: 1 });
    expect(l).toMatchObject({ unit: "L", qtyRaw: "3", priceRaw: "9000", tax: { ivaPct: 19, inc: true }, incRaw: "8", incIsPct: true });
  });

  it("presentación pedida antes sin precio en la lista: las presentaciones y el precio de esa orden", () => {
    const l = pickIngredient(blankLine(1), eggs, catalog);
    expect(l).toMatchObject({ unit: PRES, qtyRaw: "4", priceRaw: "18000", priceSource: "history" });
  });

  it("sin historia ni presentación: kg y el precio de referencia (como el formulario anterior)", () => {
    const l = pickIngredient(blankLine(1), sugar, catalog);
    expect(l).toMatchObject({ unit: "kg", qtyRaw: "1", priceRaw: "4000", priceSource: "reference", tax: { ivaPct: 0, inc: false } });
    // 2,5 kg con referencia $25.000/kg → $62.500, la misma sugerencia de antes.
    const ref = pickIngredient(blankLine(1), { ...sugar, referencePriceCents: 2_500_000 }, { priceList: [], history: [] });
    expect(lineListCents({ ...ref, qtyRaw: "2,5" })).toBe(6_250_000);
  });

  it("en monedas sin decimales, el precio calculado se redondea a pesos enteros", () => {
    // Última orden: 6 kg por $35.500 → $5.916,67/kg; en COP se propone $5.917.
    const h = [hist({ ingredientId: "sugar", qtyBase: 6000, listCostCents: 3_550_000 })];
    expect(pickIngredient(blankLine(1), sugar, { priceList: [], history: h })).toMatchObject({ priceRaw: "5916.67" });
    expect(pickIngredient(blankLine(1), sugar, { priceList: [], history: h }, { dec: ",", step: 100 })).toMatchObject({ priceRaw: "5917" });
    const odd = picked(beef, { qtyRaw: "1", priceRaw: "100001" });
    expect(changeUnit(odd, "kg", { dec: ",", step: 100 }).priceRaw).toBe("2000");
    expect(changeUnit(odd, "kg").priceRaw).toBe("2000.02");
  });

  it("precio sugerido al cambiar de unidad", () => {
    expect(suggestPrice(beef, sack, undefined, "kg")).toEqual({ cents: 360_000, source: "list" });
    expect(suggestPrice(eggs, tray, undefined, PRES)).toEqual({ cents: 1_800_000, source: "reference" });
    expect(suggestPrice(oil, null, undefined, "L")).toBeNull();
  });
});

describe("cambiar la unidad conserva lo físico y la plata", () => {
  it("2 bultos de 50 kg a $180.000 ↔ 100 kg a $3.600", () => {
    const pres = picked(beef, { qtyRaw: "2" });
    const kg = changeUnit(pres, "kg");
    expect(kg).toMatchObject({ unit: "kg", qtyRaw: "100", priceRaw: "3600" });
    expect(lineListCents(kg)).toBe(lineListCents(pres));
    expect(changeUnit(kg, PRES)).toMatchObject({ unit: PRES, qtyRaw: "2", priceRaw: "180000" });
  });

  it("kg → g convierte la cantidad; el precio sigue por kg", () => {
    const g = changeUnit(picked(rice, { qtyRaw: "2,5", priceRaw: "4500" }), "g");
    expect(g).toMatchObject({ unit: "g", qtyRaw: "2500", priceRaw: "4500" });
    expect(lineListCents(g)).toBe(1_125_000);
  });

  it("al cambiar de proveedor, la presentación del otro pasa a kg con el mismo total", () => {
    const pres = picked(beef, { qtyRaw: "2" });
    const free = detachLine(pres);
    expect(free).toMatchObject({ unit: "kg", qtyRaw: "100", supplierItem: null, priceSource: null });
    expect(lineListCents(free)).toBe(36_000_000);
    expect(resolveLine(free)).toMatchObject({ supplierItemId: null, presentations: null, qtyBase: 100_000 });
  });
});

/* ────────────────────────── Filas: operaciones ─────────────────────── */

describe("operaciones de filas", () => {
  it("agrega una fila en blanco debajo con la siguiente key y la quita", () => {
    const lines = [picked(rice, {}, 1), picked(beef, {}, 4)];
    const { lines: next, key } = insertBlankAfter(lines, 0);
    expect(key).toBe(5);
    expect(next.map((l) => l.key)).toEqual([1, 5, 4]);
    expect(isBlankLine(next[1]!)).toBe(true);
    expect(removeLine(next, 5).map((l) => l.key)).toEqual([1, 4]);
    expect(nextKey([])).toBe(1);
  });

  it("detecta el insumo repetido", () => {
    const lines = [picked(rice, {}, 1), picked(beef, {}, 2), picked(rice, {}, 3)];
    expect(duplicateOf(lines, 3)?.key).toBe(1);
    expect(duplicateOf(lines, 2)).toBeNull();
    expect(duplicateOf([blankLine(1), blankLine(2)], 2)).toBeNull();
  });

  it("suma dos filas al mismo precio y sigue calculando con él", () => {
    const lines = [picked(rice, { qtyRaw: "25" }, 1), picked(beef, {}, 2), picked(rice, { qtyRaw: "5" }, 3)];
    const merged = mergeLines(lines, 1, 3)!;
    expect(merged.map((l) => l.key)).toEqual([1, 2]);
    expect(merged[0]).toMatchObject({ qtyRaw: "30", totalRaw: null, priceRaw: "4500" });
    expect(lineListCents(merged[0]!)).toBe(13_500_000);
  });

  it("con precios distintos, el total es la suma exacta de las dos", () => {
    const lines = [picked(rice, { qtyRaw: "2", priceRaw: "4500" }, 1), picked(rice, { qtyRaw: "1", priceRaw: "5000" }, 2)];
    const merged = mergeLines(lines, 1, 2)!;
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ qtyRaw: "3", totalRaw: "14000" });
    expect(lineListCents(merged[0]!)).toBe(1_400_000);
  });

  it("presentaciones + presentaciones; presentaciones + kg que no dan exactas → kg", () => {
    const two = [picked(beef, { qtyRaw: "2" }, 1), picked(beef, { qtyRaw: "1" }, 2)];
    expect(mergeLines(two, 1, 2)![0]).toMatchObject({ unit: PRES, qtyRaw: "3", totalRaw: null });
    const mixed = [picked(beef, { qtyRaw: "2" }, 1), picked(beef, { unit: "kg", qtyRaw: "30", priceRaw: "3600" }, 2)];
    const m = mergeLines(mixed, 1, 2)![0]!;
    expect(m).toMatchObject({ unit: "kg", qtyRaw: "130" });
    expect(lineListCents(m)).toBe(36_000_000 + 10_800_000);
  });

  it("no suma si a una de las dos le falta cantidad o precio", () => {
    const lines = [picked(rice, { qtyRaw: "2" }, 1), picked(rice, { qtyRaw: "" }, 2)];
    expect(mergeLines(lines, 1, 2)).toBeNull();
  });

  it("habituales y reorden: no repite insumos y deja las filas en blanco al final", () => {
    const existing = [picked(rice, {}, 1), blankLine(2)];
    const r = linesForIngredients(existing, [{ ingredientId: "rice" }, { ingredientId: "oil" }, { ingredientId: "gone" }], catalog);
    expect(r).toMatchObject({ added: 1, skipped: 2 });
    expect(r.lines.map((l) => l.ingredient?.id ?? null)).toEqual(["rice", "oil", null]);
    const reorder = linesForIngredients([], [{ ingredientId: "beef", presentations: 3 }], catalog);
    expect(reorder.lines[0]).toMatchObject({ unit: PRES, qtyRaw: "3", priceRaw: "180000", priceSource: "list" });
  });
});

/* ───────────────────────────── Validación ──────────────────────────── */

describe("validación por celda", () => {
  it("una fila en blanco no tiene errores ni se manda", () => {
    expect(lineIssues(blankLine(1))).toEqual({});
    expect(resolveLines([blankLine(1)])).toEqual({ lines: [], keys: [], invalidKeys: [] });
  });

  it("marca la celda con el problema", () => {
    expect(lineIssues({ ...blankLine(1), qtyRaw: "3" })).toMatchObject({ item: "itemRequired", price: "priceRequired" });
    expect(lineIssues(picked(rice, { qtyRaw: "" }))).toEqual({ qty: "qtyRequired" });
    expect(lineIssues(picked(beef, { qtyRaw: "1,5" }))).toEqual({ qty: "qtyWhole" });
    expect(lineIssues(picked(rice, { qtyRaw: "1,5", unit: "g" }))).toEqual({ qty: "qtyInvalid" });
    expect(lineIssues(picked(oil, { qtyRaw: "2", priceRaw: "" }))).toEqual({ price: "priceRequired" });
    expect(lineIssues(picked(rice, { qtyRaw: "2", priceRaw: "99999999" }))).toEqual({ price: "priceInvalid" });
    expect(lineIssues(picked(rice, { qtyRaw: "2", priceRaw: "0" }))).toEqual({});
  });

  it("separa las filas listas de las que tienen problemas", () => {
    const r = resolveLines([picked(rice, { qtyRaw: "2" }, 1), blankLine(2), picked(oil, { priceRaw: "" }, 3)]);
    expect(r.keys).toEqual([1]);
    expect(r.invalidKeys).toEqual([3]);
  });
});

/* ──────────────────────── Teclado de la tabla ──────────────────────── */

describe("teclado de la tabla", () => {
  const base: GridKeyInput = {
    key: "Enter",
    mod: false,
    shift: false,
    col: "qty",
    row: 2,
    rowCount: 4,
    rowBlank: false,
    nextRowBlank: false,
    inputEmpty: false,
    listOpen: false,
  };
  const act = (p: Partial<GridKeyInput>) => gridKeyAction({ ...base, ...p });

  it("Enter abre una fila debajo con el foco en su insumo", () => {
    expect(act({})).toEqual({ action: { kind: "addBelow", row: 2 }, preventDefault: true });
    expect(act({ nextRowBlank: true })).toEqual({ action: { kind: "focus", row: 3, col: "item" }, preventDefault: true });
    expect(act({ rowBlank: true })).toEqual({ action: { kind: "none" }, preventDefault: true });
    expect(act({ listOpen: true }).action.kind).toBe("none");
    expect(act({ shift: true }).action.kind).toBe("none");
  });

  it("Ctrl/⌘ + Enter crea la orden", () => {
    expect(act({ mod: true })).toEqual({ action: { kind: "submit" }, preventDefault: true });
  });

  it("Retroceso en el insumo vacío de una fila en blanco la quita y sube", () => {
    expect(act({ key: "Backspace", col: "item", inputEmpty: true, rowBlank: true })).toEqual({
      action: { kind: "remove", row: 2, focusRow: 1 },
      preventDefault: true,
    });
    expect(act({ key: "Backspace", col: "item", inputEmpty: true, rowBlank: true, row: 0 }).action).toEqual({ kind: "remove", row: 0, focusRow: 0 });
    // La única fila, una fila con datos o un campo con texto: Retroceso normal.
    expect(act({ key: "Backspace", col: "item", inputEmpty: true, rowBlank: true, rowCount: 1 }).action.kind).toBe("none");
    expect(act({ key: "Backspace", col: "item", inputEmpty: true }).action.kind).toBe("none");
    expect(act({ key: "Backspace", col: "qty", inputEmpty: true, rowBlank: true }).action.kind).toBe("none");
  });

  it("↑/↓ cambian de fila en las columnas de números, no en los select", () => {
    expect(act({ key: "ArrowDown", col: "price" })).toEqual({ action: { kind: "focus", row: 3, col: "price" }, preventDefault: true });
    expect(act({ key: "ArrowUp", col: "total" }).action).toEqual({ kind: "focus", row: 1, col: "total" });
    expect(act({ key: "ArrowDown", row: 3 }).action.kind).toBe("none");
    expect(act({ key: "ArrowDown", col: "tax" }).action.kind).toBe("none");
    expect(act({ key: "ArrowDown", col: "item" }).action.kind).toBe("none");
  });
});

/* ──────────────────────── Buscador de insumos ──────────────────────── */

describe("buscador de insumos", () => {
  const options = ingredientOptions(catalog);
  const names = (q: string) => rankOptions(options, q).map((o) => o.ingredient.name);

  it("sin búsqueda: primero lo de este proveedor (lo más pedido arriba), después el resto", () => {
    expect(names("")).toEqual(["Arroz blanco", "Huevo AA", "Aceite vegetal", "Lomo de res", "Azúcar"]);
  });

  it("sin tildes, por nombre o por presentación", () => {
    expect(names("azucar")).toEqual(["Azúcar"]);
    expect(names("bulto")).toEqual(["Lomo de res"]);
    expect(names("a")).toContain("Aceite vegetal");
  });

  it("toma el nombre exacto escrito sin elegirlo", () => {
    expect(exactOption(options, "arroz BLANCO")?.ingredient.id).toBe("rice");
    expect(exactOption(options, "arroz")).toBeNull();
  });
});

/* ────────────────────────────── Totales ────────────────────────────── */

describe("totales (el mismo cálculo del servidor)", () => {
  it("descuento por línea, descuento del pie prorrateado, IVA por línea y consumo sobre el neto", () => {
    const lines: ResolvedOcLine[] = [
      { ingredientId: "rice", supplierItemId: null, presentations: null, qtyBase: 10_000, expectedCostCents: 4_500_000, taxPct: 5, inc: false, incRaw: "", incIsPct: true, discRaw: "10", discIsPct: true },
      { ingredientId: "oil", supplierItemId: null, presentations: null, qtyBase: 3000, expectedCostCents: 2_700_000, taxPct: 19, inc: true, incRaw: "8", incIsPct: true, discRaw: "", discIsPct: true },
    ];
    const t = draftTotals(lines, "1000", false);
    const applied = resolveOrderDiscounts(
      [
        { listCents: 4_500_000, discount: { pct: 10, cents: null } },
        { listCents: 2_700_000, discount: { pct: null, cents: null } },
      ],
      { pct: null, cents: 100_000 },
    );
    expect(t.applied).toEqual(applied);
    expect(t.subtotalCents).toBe(7_200_000);
    expect(t.discountCents).toBe(450_000 + 100_000);
    const [rNet, oNet] = applied.lines.map((a) => a.netCents) as [number, number];
    expect(t.ivaCents).toBe(Math.round(rNet * 0.05) + Math.round(oNet * 0.19));
    expect(t.lineIncs).toEqual([0, lineIncCents(oNet, { pct: 8, cents: null })]);
    expect(t.totalCents).toBe(rNet + oNet + t.ivaCents + t.incCents);
    expect(t.invoiceDoc).toEqual({ baseCents: rNet + oNet, ivaCents: t.ivaCents, incCents: t.incCents });
  });
});

/* ─────────────────── POST: igual al formulario anterior ────────────── */

/**
 * Copia LITERAL de cómo armaba el cuerpo el formulario anterior
 * (ComprasClient · NewOrderSheet.submit, #393/#571/#581), con su propia
 * copia de los descuentos persistidos. El nuevo debe mandar lo mismo.
 */
type LegacyDraftLine = {
  ingredientId: string;
  supplierItemId: string | null;
  presentations: number | null;
  qtyBase: number;
  expectedCostCents: number;
  taxPct: number;
  inc: boolean;
  incRaw: string;
  incIsPct: boolean;
  discRaw: string;
  discIsPct: boolean;
};

function legacyPersisted(lines: { listCents: number; discRaw: string; discIsPct: boolean }[], orderRaw: string, orderIsPct: boolean) {
  const lineDiscounts = lines.map((l) => toPersistedDiscount(l.listCents, parseDiscountInput(l.discRaw, l.discIsPct)));
  const afterLine = lines.reduce((sum, l, i) => sum + l.listCents - discountAmountCents(l.listCents, lineDiscounts[i]!), 0);
  return { lines: lineDiscounts, order: toPersistedDiscount(afterLine, parseDiscountInput(orderRaw, orderIsPct)) };
}

function legacyBody(input: {
  supplierId: string;
  lines: LegacyDraftLine[];
  orderDiscRaw: string;
  orderDiscIsPct: boolean;
  notes: string;
  expectedAt: string;
  receivedNow: boolean;
  invoiceNumber: string;
  invoiceDueAt: string;
  retentions: { retefuenteCents: number; reteIvaCents: number; reteIcaCents: number };
}) {
  const { lines, receivedNow } = input;
  const persisted = legacyPersisted(
    lines.map((l) => ({ listCents: l.expectedCostCents, discRaw: l.discRaw, discIsPct: l.discIsPct })),
    input.orderDiscRaw,
    input.orderDiscIsPct,
  );
  const applied = resolveOrderDiscounts(
    lines.map((l, i) => ({ listCents: l.expectedCostCents, discount: persisted.lines[i]! })),
    persisted.order,
  );
  const lineIncs = lines.map((l, i) => (l.inc ? lineIncCents(applied.lines[i]!.netCents ?? 0, parseDiscountInput(l.incRaw, l.incIsPct)) : 0));
  return {
    supplierId: input.supplierId,
    lines: lines.map((l, i) =>
      l.supplierItemId
        ? {
            ingredientId: l.ingredientId,
            supplierItemId: l.supplierItemId,
            presentations: l.presentations,
            expectedCostCents: l.expectedCostCents,
            taxPct: l.taxPct,
            expectedIncCents: lineIncs[i] ?? 0,
            ...persisted.lines[i],
          }
        : {
            ingredientId: l.ingredientId,
            qtyBase: l.qtyBase,
            expectedCostCents: l.expectedCostCents,
            taxPct: l.taxPct,
            expectedIncCents: lineIncs[i] ?? 0,
            ...persisted.lines[i],
          },
    ),
    ...persisted.order,
    notes: input.notes.trim() || null,
    expectedAt: !receivedNow && input.expectedAt ? new Date(`${input.expectedAt}T12:00:00`).toISOString() : null,
    ...(receivedNow
      ? {
          receive: {
            supplierInvoiceNumber: input.invoiceNumber.trim() || null,
            invoiceDueAt: input.invoiceDueAt ? new Date(`${input.invoiceDueAt}T12:00:00`).toISOString() : null,
            ...input.retentions,
          },
        }
      : {}),
  };
}

/** El formulario anterior mandaba los descuentos como `pct`/`cents`: el API
 *  los lee como `discountPct`/`discountCents` (y descartaba los otros). */
function withApiDiscountKeys<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  const { pct, cents, ...rest } = o as T & { pct?: unknown; cents?: unknown };
  return { ...rest, discountPct: pct, discountCents: cents };
}

describe("cuerpo del POST: el mismo contrato de antes", () => {
  // Las filas como las arma la pantalla nueva…
  const ui: OcLine[] = [
    picked(beef, { qtyRaw: "2", discRaw: "12,5", discIsPct: true, tax: { ivaPct: 19, inc: false } }, 1),
    picked(rice, { qtyRaw: "2,5", priceRaw: "4500", discRaw: "1000", discIsPct: false, tax: { ivaPct: 5, inc: false } }, 2),
    picked(oil, { qtyRaw: "3", priceRaw: "9000", totalRaw: "26500", discRaw: "", tax: { ivaPct: 19, inc: true }, incRaw: "8", incIsPct: true }, 3),
    picked(eggs, { qtyRaw: "1", tax: { ivaPct: 0, inc: true }, incRaw: "500", incIsPct: false }, 4),
    blankLine(5),
  ];
  const resolved = resolveLines(ui).lines;
  // …y las mismas filas como las tenía el formulario anterior (DraftLine).
  const legacyLines: LegacyDraftLine[] = [
    { ingredientId: "beef", supplierItemId: "si-beef", presentations: 2, qtyBase: 100_000, expectedCostCents: 36_000_000, taxPct: 19, inc: false, incRaw: "", incIsPct: true, discRaw: "12,5", discIsPct: true },
    { ingredientId: "rice", supplierItemId: null, presentations: null, qtyBase: 2500, expectedCostCents: 1_125_000, taxPct: 5, inc: false, incRaw: "", incIsPct: true, discRaw: "1000", discIsPct: false },
    { ingredientId: "oil", supplierItemId: null, presentations: null, qtyBase: 3000, expectedCostCents: 2_650_000, taxPct: 19, inc: true, incRaw: "8", incIsPct: true, discRaw: "", discIsPct: true },
    { ingredientId: "eggs", supplierItemId: "si-eggs", presentations: 1, qtyBase: 30_000, expectedCostCents: 1_800_000, taxPct: 0, inc: true, incRaw: "500", incIsPct: false, discRaw: "", discIsPct: true },
  ];
  const common = {
    supplierId: "sup",
    orderDiscRaw: "5",
    orderDiscIsPct: true,
    notes: "  Entregar antes de las 9  ",
    expectedAt: "2026-11-10",
    invoiceNumber: " FE-1234 ",
    invoiceDueAt: "2026-12-01",
    retentions: { retefuenteCents: 125_000, reteIvaCents: 0, reteIcaCents: 41_400 },
  };

  it("las filas de la pantalla resuelven a las del formulario anterior", () => {
    expect(resolved.map((l) => ({ ...l }))).toEqual(legacyLines);
  });

  for (const receivedNow of [false, true]) {
    it(`mismo cuerpo ${receivedNow ? "con «Ya recibí esta mercancía»" : "para una orden por recibir"}`, () => {
      const next = buildCreateOrderPayload({ ...common, receivedNow, lines: resolved });
      const legacy = legacyBody({ ...common, receivedNow, lines: legacyLines });
      const expected = { ...withApiDiscountKeys(legacy), lines: legacy.lines.map(withApiDiscountKeys) };
      expect(next).toEqual(expected);
      expect(JSON.parse(JSON.stringify(next))).toEqual(JSON.parse(JSON.stringify(expected)));
    });
  }

  it("sin descuentos, todo lo demás es idéntico byte a byte", () => {
    const plain = legacyLines.map((l) => ({ ...l, discRaw: "" }));
    const next = buildCreateOrderPayload({ ...common, orderDiscRaw: "", receivedNow: false, lines: plain });
    const legacy = legacyBody({ ...common, orderDiscRaw: "", receivedNow: false, lines: plain });
    const DISCOUNT_KEYS = new Set(["discountPct", "discountCents", "pct", "cents"]);
    const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !DISCOUNT_KEYS.has(k)));
    expect({ ...strip(next), lines: next.lines.map((l) => strip(l)) }).toEqual({
      ...strip(legacy),
      lines: legacy.lines.map((l) => strip(l)),
    });
    expect(next.lines.every((l) => l.discountPct === null && l.discountCents === null)).toBe(true);
  });

  it("los descuentos viajan con los nombres que lee el API (#393), por línea y del pie", () => {
    const body = buildCreateOrderPayload({ ...common, receivedNow: false, lines: resolved });
    expect(body.lines.map((l) => [l.discountPct, l.discountCents])).toEqual([
      // 12,5 % no es entero: viaja como su valor sobre la base.
      [null, 4_500_000],
      [null, 100_000],
      [null, null],
      [null, null],
    ]);
    expect([body.discountPct, body.discountCents]).toEqual([5, null]);
    expect(persistedOrderDiscounts(
      resolved.map((l) => ({ listCents: l.expectedCostCents, discRaw: l.discRaw, discIsPct: l.discIsPct })),
      "5",
      true,
    )).toEqual(legacyPersisted(
      resolved.map((l) => ({ listCents: l.expectedCostCents, discRaw: l.discRaw, discIsPct: l.discIsPct })),
      "5",
      true,
    ));
  });

  it("fechas al mediodía local y notas recortadas", () => {
    const body = buildCreateOrderPayload({ ...common, receivedNow: false, lines: resolved });
    expect(body.expectedAt).toBe(dateInputToIso("2026-11-10"));
    expect(body.notes).toBe("Entregar antes de las 9");
    expect("receive" in body).toBe(false);
    const received = buildCreateOrderPayload({ ...common, receivedNow: true, lines: resolved });
    expect(received.expectedAt).toBeNull();
    expect(received.receive).toEqual({ supplierInvoiceNumber: "FE-1234", invoiceDueAt: dateInputToIso("2026-12-01"), ...common.retentions });
  });
});
