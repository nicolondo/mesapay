// Validaciones compartidas de gastos (ERP B2) — las usan las rutas de
// /api/operator/expenses (un route.ts no puede exportar helpers) y el cron
// de recurrentes. El cálculo de impuestos es PURO (expenseTax.ts); acá se
// resuelve contra la BD lo que el cliente no puede decidir: los conceptos
// de retención del comercio (tarifa, cuenta), si el IVA es descontable y
// que la cuenta de cada retención exista en el plan.
import { z } from "zod";
import { db } from "@/lib/db";
import { resolvePostableCode } from "./chart";
import { ENGINE } from "./engineCodes";
import {
  EXPENSE_DOCUMENT_TYPES,
  EXPENSE_MAX_CENTS,
  expenseAmounts,
  expenseTaxError,
  retentionAmountCents,
  retentionBaseCents,
  type ExpenseAmounts,
  type ExpenseTaxError,
} from "./expenseTax";
import { computeRetentions } from "./retencionesCore";
import { loadAccountIndex, type AccountIndexEntry } from "./ledger";
import { POSSIBLE_DUPLICATE_MODES } from "./documentNumber";

const cents = z.number().int().min(0).max(EXPENSE_MAX_CENTS);

/** Una retención del formulario: del concepto del comercio, o una ya guardada cuyo concepto se borró. */
export const expenseRetentionInputSchema = z
  .object({
    conceptId: z.string().min(1).nullable().optional(),
    /** Id de una `ExpenseRetention` del MISMO gasto (concepto ya borrado). */
    sourceId: z.string().min(1).nullable().optional(),
    amountCents: cents,
  })
  .refine((r) => Boolean(r.conceptId) !== Boolean(r.sourceId));

export type ExpenseRetentionInput = z.infer<typeof expenseRetentionInputSchema>;

export const expenseBodySchema = z.object({
  category: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  /**
   * Gasto SIN impuestos (el formulario viejo): base = costo = total a pagar.
   * Con impuestos se manda `subtotalCents` y lo demás; si vienen los dos,
   * mandan los impuestos.
   */
  amountCents: z.number().int().min(1).max(EXPENSE_MAX_CENTS).optional(),
  // ── Impuestos (ver expenseTax.ts) ──
  subtotalCents: z.number().int().min(1).max(EXPENSE_MAX_CENTS).optional(),
  discountCents: cents.optional(),
  ivaPct: z.number().int().min(0).max(100).optional(),
  /** IVA impreso: manda sobre la tarifa. null = calcular por tarifa. */
  ivaCents: cents.nullable().optional(),
  incCents: cents.optional(),
  retentions: z.array(expenseRetentionInputSchema).max(10).optional(),
  // ── Documento soporte ──
  documentType: z.enum(EXPENSE_DOCUMENT_TYPES).optional(),
  documentNumber: z.string().trim().max(60).nullable().optional(),
  documentDate: z.string().datetime().nullable().optional(),
  /** Sólo archivos subidos por /api/operator/expenses/attachments. */
  attachmentUrl: z
    .string()
    .regex(/^\/uploads\/gasto-[a-f0-9]{16}\.(pdf|jpg|png|webp)$/)
    .nullable()
    .optional(),
  date: z.string().datetime(),
  supplierId: z.string().min(1).nullable().optional(),
  costCenterId: z.string().min(1).nullable().optional(),
  recurring: z.boolean().optional(),
  recurringDay: z.number().int().min(1).max(28).nullable().optional(),
  /** Cuenta del PUC a la que se carga el gasto. null = derivar de la categoría. */
  accountCode: z.string().trim().min(4).max(10).nullable().optional(),
  /** Vencimiento, si queda debiéndose. */
  dueAt: z.string().datetime().nullable().optional(),
  /**
   * Pago de contado: la cuenta de donde sale la plata. Si viene, se crea el
   * abono por el TOTAL A PAGAR en la misma transacción y el gasto queda
   * saldado en un solo paso.
   */
  payFromAccountCode: z.string().trim().min(4).max(10).nullable().optional(),
  /**
   * Gasto sin número de documento parecido a otro del mismo proveedor (mismo
   * día y total): "check" pide la advertencia (409 `possible_duplicate`),
   * "allow" = el operador la vio y guarda igual. Ausente = no se revisa. El
   * documento repetido CON número se bloquea siempre (`duplicate_document`).
   */
  possibleDuplicate: z.enum(POSSIBLE_DUPLICATE_MODES).optional(),
});

export type ExpenseBody = z.infer<typeof expenseBodySchema>;

/** ¿El cuerpo trae algún campo de impuestos? (PATCH: si no, los montos no se tocan). */
export function bodyTouchesAmounts(b: Partial<ExpenseBody>): boolean {
  return (
    b.amountCents !== undefined ||
    b.subtotalCents !== undefined ||
    b.discountCents !== undefined ||
    b.ivaPct !== undefined ||
    b.ivaCents !== undefined ||
    b.incCents !== undefined ||
    b.retentions !== undefined
  );
}

/** recurring ⇔ recurringDay van juntos. */
export function recurrenceError(b: {
  recurring: boolean;
  recurringDay?: number | null;
}): string | null {
  if (b.recurring && b.recurringDay == null) return "recurring_day_required";
  if (!b.recurring && b.recurringDay != null) return "recurring_day_forbidden";
  return null;
}

export function dateInRange(date: Date): boolean {
  const y = date.getUTCFullYear();
  return !Number.isNaN(y) && y >= 2020 && y <= 2100;
}

export async function supplierOwned(
  supplierId: string | null | undefined,
  restaurantId: string,
): Promise<boolean> {
  if (!supplierId) return true;
  const s = await db.supplier.findUnique({
    where: { id: supplierId },
    select: { restaurantId: true },
  });
  return s?.restaurantId === restaurantId;
}

// ── Impuestos: del formulario a lo que se guarda ──────────────────────────

/** Fila de `ExpenseRetention` lista para crear (sin expenseId). */
export type ExpenseRetentionRow = {
  conceptId: string | null;
  kind: string;
  name: string;
  rateBps: number;
  base: string;
  accountCode: string;
  baseCents: number;
  amountCents: number;
};

/** Una retención guardada (para conservar la foto de un concepto ya borrado). */
export type StoredRetention = ExpenseRetentionRow & { id: string };

/** Lo que se le pasa al cálculo: montos del formulario (o del gasto, en un PATCH parcial). */
export type ExpenseTaxPayload = {
  subtotalCents: number;
  discountCents: number;
  ivaPct: number;
  ivaCents: number | null;
  incCents: number;
  retentions: readonly ExpenseRetentionInput[];
};

/** Campos de montos que se escriben en `Expense`. */
export type ExpenseAmountFields = {
  amountCents: number;
  baseCents: number;
  discountCents: number;
  ivaPct: number;
  ivaCents: number;
  ivaDeductible: boolean;
  incCents: number;
  retefuenteCents: number;
  reteIvaCents: number;
  reteIcaCents: number;
  payableCents: number;
};

export function amountFieldsOf(a: ExpenseAmounts, ivaDeductible: boolean): ExpenseAmountFields {
  return {
    amountCents: a.costCents,
    baseCents: a.baseCents,
    discountCents: a.discountCents,
    ivaPct: a.ivaPct,
    ivaCents: a.ivaCents,
    ivaDeductible,
    incCents: a.incCents,
    retefuenteCents: a.retefuenteCents,
    reteIvaCents: a.reteIvaCents,
    reteIcaCents: a.reteIcaCents,
    payableCents: a.payableCents,
  };
}

const ENGINE_RETENTION_CODE: Record<string, string> = {
  retefuente: ENGINE.RETEFUENTE,
  reteiva: ENGINE.RETEIVA,
  reteica: ENGINE.RETEICA,
};

/**
 * Cuenta que se acredita por una retención: la del concepto si existe en el
 * plan del comercio (o tiene auxiliares imputables); si no, la del motor
 * para ese tipo (2365/2367/2368, las mismas de las compras). Sin esto, un
 * concepto con una cuenta que el plan no tiene dejaría el asiento «Gastos
 * del día» entero sin generar (el motor omite el asiento cuya cuenta no
 * encuentra).
 */
export function retentionAccountFor(
  index: ReadonlyMap<string, AccountIndexEntry>,
  kind: string,
  conceptCode: string,
): string {
  if (conceptCode && resolvePostableCode(index, conceptCode)) return conceptCode;
  return ENGINE_RETENTION_CODE[kind] ?? ENGINE.RETEFUENTE;
}

export type ResolvedExpenseTaxes =
  | { ok: true; fields: ExpenseAmountFields; retentions: ExpenseRetentionRow[]; amounts: ExpenseAmounts }
  | { ok: false; error: ExpenseTaxError | "retention_not_found" };

/**
 * Del formulario a lo que se guarda: resuelve cada retención contra SU
 * concepto (tarifa, nombre y cuenta los pone el servidor; del cliente sólo
 * se toma el monto, que el operador puede ajustar), calcula los totales con
 * el motor puro y aplica las reglas (`expenseTaxError`).
 */
export async function resolveExpenseTaxes(args: {
  restaurantId: string;
  payload: ExpenseTaxPayload;
  ivaDeductible: boolean;
  hasSupplier: boolean;
  /** Retenciones guardadas del gasto (PATCH): para las de un concepto borrado. */
  existing?: readonly StoredRetention[];
}): Promise<ResolvedExpenseTaxes> {
  const { restaurantId, payload } = args;
  const inputs = payload.retentions.filter((r) => r.amountCents > 0);
  const conceptIds = [...new Set(inputs.map((r) => r.conceptId).filter((id): id is string => Boolean(id)))];
  const [concepts, index] = await Promise.all([
    conceptIds.length
      ? db.retentionConcept.findMany({ where: { restaurantId, id: { in: conceptIds } } })
      : Promise.resolve([]),
    inputs.length ? loadAccountIndex(restaurantId) : Promise.resolve(new Map<string, AccountIndexEntry>()),
  ]);
  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  const existingById = new Map((args.existing ?? []).map((r) => [r.id, r]));

  // Montos sin retenciones primero: la base de cada retención depende de
  // la base y el IVA del gasto.
  const pre = expenseAmounts({ ...payload, ivaDeductible: args.ivaDeductible, retentions: [] });
  const rows: ExpenseRetentionRow[] = [];
  for (const r of inputs) {
    if (r.conceptId) {
      const c = conceptById.get(r.conceptId);
      if (!c) return { ok: false, error: "retention_not_found" };
      rows.push({
        conceptId: c.id,
        kind: c.kind,
        name: c.name,
        rateBps: c.rateBps,
        base: c.base,
        accountCode: retentionAccountFor(index, c.kind, c.accountCode),
        baseCents: retentionBaseCents(c, pre),
        amountCents: r.amountCents,
      });
    } else {
      const prev = r.sourceId ? existingById.get(r.sourceId) : undefined;
      if (!prev) return { ok: false, error: "retention_not_found" };
      rows.push({
        conceptId: null,
        kind: prev.kind,
        name: prev.name,
        rateBps: prev.rateBps,
        base: prev.base,
        accountCode: retentionAccountFor(index, prev.kind, prev.accountCode),
        baseCents: retentionBaseCents(prev, pre),
        amountCents: r.amountCents,
      });
    }
  }
  const amounts = expenseAmounts({ ...payload, ivaDeductible: args.ivaDeductible, retentions: rows });
  const error = expenseTaxError(amounts, { hasSupplier: args.hasSupplier, retentions: rows });
  if (error) return { ok: false, error };
  return { ok: true, fields: amountFieldsOf(amounts, args.ivaDeductible), retentions: rows, amounts };
}

/** Del cuerpo de la API al payload del cálculo (null si no trae monto). */
export function taxPayloadFromBody(b: Partial<ExpenseBody>): ExpenseTaxPayload | null {
  if (b.subtotalCents !== undefined) {
    return {
      subtotalCents: b.subtotalCents,
      discountCents: b.discountCents ?? 0,
      ivaPct: b.ivaPct ?? 0,
      ivaCents: b.ivaCents ?? null,
      incCents: b.incCents ?? 0,
      retentions: b.retentions ?? [],
    };
  }
  if (b.amountCents !== undefined) {
    // Formulario sin impuestos: el valor es base, costo y total a pagar.
    return { subtotalCents: b.amountCents, discountCents: 0, ivaPct: 0, ivaCents: null, incCents: 0, retentions: [] };
  }
  return null;
}

// ── Copias de plantillas recurrentes ──────────────────────────────────────

/** Lo que el cron necesita de una plantilla para copiar sus impuestos. */
export type TemplateTaxSource = {
  baseCents: number;
  discountCents: number;
  ivaPct: number;
  ivaCents: number;
  ivaDeductible: boolean;
  incCents: number;
  amountCents: number;
  payableCents: number;
  retentions: readonly (StoredRetention & {
    concept: { id: string; kind: string; name: string; rateBps: number; base: string; thresholdUvt: number; accountCode: string; active: boolean } | null;
  })[];
};

/**
 * Impuestos de la COPIA de una plantilla: mismos montos (base, IVA, INC,
 * descuento), con las retenciones RECALCULADAS con el umbral UVT del año de
 * la copia y la tarifa vigente de su concepto (si el concepto se desactivó,
 * el comercio dejó de practicarla: la copia no la lleva). Una línea cuyo
 * concepto se borró conserva su tarifa guardada, sin umbral. Pura.
 */
export function templateCopyTaxes(
  t: TemplateTaxSource,
  uvtCents: number,
): { fields: ExpenseAmountFields; retentions: ExpenseRetentionRow[] } {
  // Plantilla anterior a los impuestos: valor plano.
  if (!(t.baseCents > 0)) {
    const plain = expenseAmounts({ subtotalCents: t.amountCents, ivaDeductible: t.ivaDeductible });
    return { fields: amountFieldsOf(plain, t.ivaDeductible), retentions: [] };
  }
  const payload = {
    subtotalCents: t.baseCents + t.discountCents,
    discountCents: t.discountCents,
    ivaPct: t.ivaPct,
    // El IVA guardado ya es el documental (impreso o por tarifa): se copia tal cual.
    ivaCents: t.ivaCents,
    ivaDeductible: t.ivaDeductible,
    incCents: t.incCents,
  };
  const pre = expenseAmounts({ ...payload, retentions: [] });
  const rows: ExpenseRetentionRow[] = [];
  for (const line of t.retentions) {
    const c = line.concept;
    if (c) {
      if (!c.active) continue;
      const res = computeRetentions([c], { subtotalCents: pre.baseCents, taxCents: pre.ivaCents }, uvtCents);
      const amount = res.lines[0]?.amountCents ?? 0;
      if (amount <= 0) continue;
      rows.push({
        conceptId: c.id,
        kind: c.kind,
        name: c.name,
        rateBps: c.rateBps,
        base: c.base,
        accountCode: line.accountCode,
        baseCents: retentionBaseCents(c, pre),
        amountCents: amount,
      });
    } else {
      const baseCents = retentionBaseCents(line, pre);
      const amount = retentionAmountCents(line.rateBps, baseCents);
      if (amount <= 0) continue;
      rows.push({
        conceptId: null,
        kind: line.kind,
        name: line.name,
        rateBps: line.rateBps,
        base: line.base,
        accountCode: line.accountCode,
        baseCents,
        amountCents: amount,
      });
    }
  }
  const amounts = expenseAmounts({ ...payload, retentions: rows });
  // Datos raros (retenciones ≥ total): la copia sale sin retenciones antes
  // que con un total a pagar en cero o negativo.
  if (amounts.payableCents < 1) {
    return { fields: amountFieldsOf(pre, t.ivaDeductible), retentions: [] };
  }
  return { fields: amountFieldsOf(amounts, t.ivaDeductible), retentions: rows };
}

/** Prisma include de un gasto con todo lo que muestra la pantalla. */
export const EXPENSE_INCLUDE = {
  supplier: { select: { id: true, name: true, taxId: true } },
  costCenter: { select: { id: true, name: true } },
  retentions: { orderBy: { createdAt: "asc" as const } },
} as const;
