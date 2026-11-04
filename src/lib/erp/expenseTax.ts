// Impuestos y retenciones de un GASTO — LÓGICA PURA, sin BD. La importan el
// formulario (cliente, para el resumen en vivo y la sugerencia de
// retenciones) y el servidor (que recalcula todo antes de guardar y en el
// cron de recurrentes). Es la misma convención fiscal de las compras
// (purchaseTax.ts / retencionesCore.ts), no un modelo paralelo:
//
//  · base       = subtotal − descuento impreso (NETO, sin IVA ni consumo).
//  · IVA        = el impreso si viene (manda), si no base × tarifa.
//  · INC        = importe aparte; siempre es costo (nunca se descuenta).
//  · retenciones= las que practica el comercio (agente retenedor), cada una
//                 sobre la base o sobre el IVA según su concepto.
//  · TOTAL A PAGAR = base + IVA + INC − retenciones  (cuentas por pagar).
//  · COSTO DEL GASTO = base + INC + IVA no descontable  (PYG / cuenta 5xxx).
//
// El IVA es descontable sólo si el comercio lo descuenta
// (`Restaurant.purchaseIvaDeductible`, foto guardada en el gasto). Un
// restaurante que cobra impuesto al consumo normalmente NO descuenta IVA:
// ahí el IVA es mayor valor del gasto.
import { discountAmountCents } from "./purchaseDiscount";
import { lineTaxCents } from "./purchaseTax";
import { computeRetentions, type RetentionConceptInput } from "./retencionesCore";
import { uvtDelAno } from "./exogena/normativa";

/** Tope de un monto en centavos (cabe en INT4, igual que el resto de gastos). */
export const EXPENSE_MAX_CENTS = 2_000_000_000;

export const EXPENSE_DOCUMENT_TYPES = ["e_invoice", "charge_account", "equivalent", "none"] as const;
export type ExpenseDocumentType = (typeof EXPENSE_DOCUMENT_TYPES)[number];

export function isExpenseDocumentType(v: unknown): v is ExpenseDocumentType {
  return typeof v === "string" && (EXPENSE_DOCUMENT_TYPES as readonly string[]).includes(v);
}

export type ExpenseRetentionKind = "retefuente" | "reteiva" | "reteica";

/** Una retención ya resuelta (con su concepto) que entra al cálculo. */
export type ExpenseRetentionAmount = {
  kind: string;
  amountCents: number;
};

export type ExpenseTaxInput = {
  /** Valor ANTES de descuento e impuestos. */
  subtotalCents: number;
  /** Descuento impreso (se resta de la base). */
  discountCents?: number;
  ivaPct?: number;
  /** IVA impreso en el documento; null/undefined = calcular por tarifa. */
  ivaCents?: number | null;
  ivaDeductible: boolean;
  incCents?: number;
  retentions?: readonly ExpenseRetentionAmount[];
};

export type ExpenseAmounts = {
  subtotalCents: number;
  discountCents: number;
  baseCents: number;
  ivaPct: number;
  ivaCents: number;
  /** IVA que va a 2408 (IVA descontable). */
  deductibleIvaCents: number;
  /** IVA que es mayor valor del gasto. */
  nonDeductibleIvaCents: number;
  incCents: number;
  retefuenteCents: number;
  reteIvaCents: number;
  reteIcaCents: number;
  retentionsCents: number;
  /** Total a pagar al proveedor. */
  payableCents: number;
  /** Costo del gasto (lo que se guarda en `Expense.amountCents`). */
  costCents: number;
};

const nonNeg = (n: number | null | undefined) => (Number.isFinite(n) && (n as number) > 0 ? Math.round(n as number) : 0);

/** Totales del gasto. Puro y determinista: lo mismo en pantalla y en el servidor. */
export function expenseAmounts(i: ExpenseTaxInput): ExpenseAmounts {
  const subtotalCents = nonNeg(i.subtotalCents);
  const discountCents = discountAmountCents(subtotalCents, { cents: nonNeg(i.discountCents) });
  const baseCents = subtotalCents - discountCents;
  const ivaPct = nonNeg(i.ivaPct);
  const ivaCents = i.ivaCents != null ? nonNeg(i.ivaCents) : lineTaxCents(baseCents, ivaPct);
  const deductibleIvaCents = i.ivaDeductible ? ivaCents : 0;
  const nonDeductibleIvaCents = ivaCents - deductibleIvaCents;
  const incCents = nonNeg(i.incCents);
  let retefuenteCents = 0;
  let reteIvaCents = 0;
  let reteIcaCents = 0;
  for (const r of i.retentions ?? []) {
    const amount = nonNeg(r.amountCents);
    if (r.kind === "reteiva") reteIvaCents += amount;
    else if (r.kind === "reteica") reteIcaCents += amount;
    else retefuenteCents += amount;
  }
  const retentionsCents = retefuenteCents + reteIvaCents + reteIcaCents;
  return {
    subtotalCents,
    discountCents,
    baseCents,
    ivaPct,
    ivaCents,
    deductibleIvaCents,
    nonDeductibleIvaCents,
    incCents,
    retefuenteCents,
    reteIvaCents,
    reteIcaCents,
    retentionsCents,
    payableCents: baseCents + ivaCents + incCents - retentionsCents,
    costCents: baseCents + incCents + nonDeductibleIvaCents,
  };
}

/** ¿El gasto lleva algo más que un valor plano? (impuestos, descuento o retenciones) */
export function expenseHasTaxes(a: Pick<ExpenseAmounts, "ivaCents" | "incCents" | "retentionsCents" | "discountCents">): boolean {
  return a.ivaCents > 0 || a.incCents > 0 || a.retentionsCents > 0 || a.discountCents > 0;
}

export type ExpenseTaxError =
  | "invalid"
  | "supplier_required"
  | "retention_exceeds_base"
  | "payable_not_positive";

/**
 * Reglas de negocio del gasto con impuestos:
 *  · base > 0 (un gasto sin valor no es un gasto);
 *  · cada retención ≤ su base (retefuente/reteICA ≤ base, reteIVA ≤ IVA);
 *  · total a pagar > 0;
 *  · con IVA o retenciones, el proveedor es obligatorio: sin tercero no hay
 *    descontable ni certificado de retención (y la exógena lo pide).
 */
export function expenseTaxError(
  a: ExpenseAmounts,
  ctx: { hasSupplier: boolean; retentions?: readonly (ExpenseRetentionAmount & { baseCents?: number })[] },
): ExpenseTaxError | null {
  if (a.baseCents < 1 || a.costCents < 1) return "invalid";
  if (a.costCents > EXPENSE_MAX_CENTS || a.subtotalCents > EXPENSE_MAX_CENTS) return "invalid";
  for (const r of ctx.retentions ?? []) {
    const limit = r.kind === "reteiva" ? a.ivaCents : a.baseCents;
    if (r.amountCents > limit) return "retention_exceeds_base";
  }
  if (a.payableCents < 1) return "payable_not_positive";
  if ((a.ivaCents > 0 || a.retentionsCents > 0) && !ctx.hasSupplier) return "supplier_required";
  return null;
}

// ── UVT y retenciones sugeridas ───────────────────────────────────────────

/**
 * UVT (centavos) del año de una fecha contable: la tabla oficial por año
 * (exógena/normativa) y, si el año no está, la que mantiene el contador en
 * `AccountingConfig.uvtCents`. Así una copia recurrente de enero de 2027
 * mide el umbral con la UVT de 2027, no con la del año en que se creó la
 * plantilla.
 */
export function uvtCentsForDate(date: Date | string, configUvtCents: number): number {
  const year = typeof date === "string" ? Number(date.slice(0, 4)) : date.getUTCFullYear();
  return uvtDelAno(year, Math.round(configUvtCents / 100)) * 100;
}

/** Concepto tal como lo necesita la sugerencia (activo o no). */
export type ExpenseRetentionConcept = RetentionConceptInput & { active?: boolean };

const RETEFUENTE_HINTS: readonly { category: RegExp; account: RegExp; concept: RegExp }[] = [
  { category: /(arriend|alquil|\blocal\b|renta|canon)/, account: /^5120/, concept: /(arrend|alquil)/ },
  { category: /(honorar|contad|asesor|abogad|jur[ií]dic|revisor)/, account: /^5110/, concept: /honorar/ },
  { category: /(compra|insumo|mercanc|suministr|papeler|aseo|desechable)/, account: /^(5195|6135)/, concept: /compra/ },
];

/**
 * El concepto de RETEFUENTE que mejor le queda al gasto. Un gasto es una
 * sola cosa (arriendo, honorarios, servicio, compra): no se le aplican a la
 * vez todos los conceptos de retefuente activos, como sí pasa con una
 * compra de insumos que usa el único activo. Por palabras de la categoría
 * o la cuenta; si nada calza, «servicios» (lo más común en gastos), luego
 * «compras», luego el primero.
 */
export function pickRetefuenteConcept<T extends ExpenseRetentionConcept>(
  concepts: readonly T[],
  ctx: { category?: string | null; accountCode?: string | null },
): T | null {
  const candidates = concepts.filter((c) => c.kind === "retefuente");
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const cat = (ctx.category ?? "").toLowerCase();
  const acc = ctx.accountCode ?? "";
  const byName = (re: RegExp) => candidates.find((c) => re.test(c.name.toLowerCase())) ?? null;
  for (const h of RETEFUENTE_HINTS) {
    if (h.category.test(cat) || (acc && h.account.test(acc))) {
      const hit = byName(h.concept);
      if (hit) return hit;
    }
  }
  return byName(/servici/) ?? byName(/compra/) ?? candidates[0]!;
}

export type SuggestedRetention = {
  conceptId: string;
  kind: string;
  name: string;
  rateBps: number;
  base: string;
  accountCode: string;
  baseCents: number;
  amountCents: number;
};

/** Base de cálculo de un concepto: el IVA (reteIVA) o la base del gasto. */
export function retentionBaseCents(concept: Pick<RetentionConceptInput, "base">, a: Pick<ExpenseAmounts, "baseCents" | "ivaCents">): number {
  return concept.base === "tax" ? a.ivaCents : a.baseCents;
}

/** Monto de una retención con la tarifa del concepto (sin umbral). */
export function retentionAmountCents(rateBps: number, baseCents: number): number {
  if (baseCents <= 0 || rateBps <= 0) return 0;
  return Math.round((baseCents * rateBps) / 10_000);
}

/**
 * Retenciones SUGERIDAS para el gasto con los conceptos ACTIVOS del
 * comercio y el umbral UVT (el mismo motor de las compras,
 * `computeRetentions`): una retefuente (la que mejor le queda), y la
 * reteIVA y la reteICA activas. Sin conceptos activos (el comercio no es
 * agente retenedor) no sugiere nada.
 */
export function suggestExpenseRetentions<T extends ExpenseRetentionConcept>(
  concepts: readonly T[],
  doc: { baseCents: number; ivaCents: number; category?: string | null; accountCode?: string | null },
  uvtCents: number,
): SuggestedRetention[] {
  const active = concepts.filter((c) => c.active !== false);
  const picked: T[] = [];
  const retefuente = pickRetefuenteConcept(active, doc);
  if (retefuente) picked.push(retefuente);
  for (const kind of ["reteiva", "reteica"] as const) {
    const c = active.find((x) => x.kind === kind);
    if (c) picked.push(c);
  }
  const result = computeRetentions(picked, { subtotalCents: doc.baseCents, taxCents: doc.ivaCents }, uvtCents);
  const byId = new Map(picked.map((c) => [c.id, c]));
  return result.lines.map((l) => {
    const c = byId.get(l.conceptId)!;
    return {
      conceptId: l.conceptId,
      kind: l.kind,
      name: l.name,
      rateBps: c.rateBps,
      base: c.base,
      accountCode: l.accountCode,
      baseCents: retentionBaseCents(c, doc),
      amountCents: l.amountCents,
    };
  });
}

// ── Gastos guardados: saldo y compatibilidad con los anteriores ──────────

/** Lo que se necesita de un gasto guardado para saber cuánto se paga. */
export type StoredExpenseAmounts = {
  amountCents: number;
  payableCents?: number | null;
  baseCents?: number | null;
};

/**
 * Total a pagar de un gasto GUARDADO. Los gastos sin impuestos (todos los
 * anteriores a esta versión, y los que cree una versión vieja del código
 * mientras conviven en el despliegue) traen `payableCents` = 0: su total
 * a pagar es su valor. Un gasto nuevo nunca guarda payable 0 (la API lo
 * exige > 0), así que no hay ambigüedad.
 */
export function expensePayableCents(e: StoredExpenseAmounts): number {
  const payable = e.payableCents ?? 0;
  return payable > 0 ? payable : e.amountCents;
}

/** Base gravable de un gasto guardado (= su valor en los que no tienen impuestos). */
export function expenseBaseCents(e: StoredExpenseAmounts): number {
  const base = e.baseCents ?? 0;
  return base > 0 ? base : e.amountCents;
}

/**
 * Enlace a un gasto: la pestaña Gastos en su mes, con el gasto abierto
 * (lo usan Impuestos del período y la cartera). `date` es la fecha
 * contable (ISO o Date); su mes UTC es el del gasto.
 */
export function expenseHref(expenseId: string, date: Date | string): string {
  const month = (typeof date === "string" ? date : date.toISOString()).slice(0, 7);
  return `/operator/contabilidad?tab=expenses&month=${month}&expense=${encodeURIComponent(expenseId)}`;
}

// ── El formulario: ¿abrir «Impuestos y retenciones» solo? ─────────────────

/**
 * ¿El documento o el proveedor sugieren que el gasto trae impuestos? Una
 * factura electrónica casi siempre discrimina IVA; una cuenta de cobro
 * suele llevar retenciones; un proveedor con NIT de persona jurídica
 * (9 dígitos que empiezan por 8 o 9, el mismo criterio de la exógena)
 * normalmente factura con IVA. Sólo ABRE la sección; nunca la cierra.
 */
export function expenseTaxesImplied(ctx: {
  documentType?: string | null;
  supplierTaxId?: string | null;
}): boolean {
  if (ctx.documentType === "e_invoice" || ctx.documentType === "charge_account") return true;
  const raw = (ctx.supplierTaxId ?? "").trim().replace(/^nit\.?\s*/i, "");
  const base = raw.replace(/\s*-\s*\d$/, "").replace(/\D/g, "");
  return base.length === 9 && /^[89]/.test(base);
}
