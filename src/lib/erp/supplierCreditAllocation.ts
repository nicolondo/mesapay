// Cruce de saldos a favor de un proveedor contra lo que se le debe —
// lógica PURA (la usan la API y la vista previa del formulario).
//
// Orden FIFO: primero lo que vence antes; a igual vencimiento, el documento
// más viejo; luego compras antes que gastos y, por último, el id (orden
// estable). Una nota que RELACIONA facturas baja primero esas; lo que sobra
// sigue FIFO por las demás; lo que aún sobra es saldo a favor.

export type PayableDocKind = "purchase" | "expense";

/** Un documento del proveedor con saldo por pagar (compra recibida o gasto). */
export type PayableDocRef = {
  kind: PayableDocKind;
  id: string;
  /** Número de la factura del proveedor (o documento del gasto), si lo tiene. */
  number: string | null;
  /** Consecutivo de la compra (OC-0007); null en gastos. */
  purchaseNumber: number | null;
  /** Consecutivo del gasto (G-0012), si el comercio lo tiene; null si no. */
  expenseNumber?: number | null;
  /** Concepto del gasto (para rotularlo si no tiene número). */
  concept?: string | null;
  /** Fecha del documento, yyyy-mm-dd. */
  date: string;
  /** Vencimiento efectivo, yyyy-mm-dd. */
  dueDate: string;
  totalCents: number;
  outstandingCents: number;
};

export type CreditAllocation = { kind: PayableDocKind; id: string; amountCents: number };

export function payableKey(d: { kind: PayableDocKind; id: string }): string {
  return `${d.kind}:${d.id}`;
}

const KIND_ORDER: Record<PayableDocKind, number> = { purchase: 0, expense: 1 };

/** Documentos en orden FIFO (vencimiento → fecha → compras antes que gastos → id). */
export function sortPayablesFifo<T extends Pick<PayableDocRef, "kind" | "id" | "date" | "dueDate">>(
  docs: readonly T[],
): T[] {
  return [...docs].sort(
    (a, b) =>
      a.dueDate.localeCompare(b.dueDate) ||
      a.date.localeCompare(b.date) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Plan por defecto para aplicar `amountCents`: las facturas relacionadas
 * (`relatedKeys`, de `payableKey`) primero, en orden FIFO entre ellas, y
 * luego las demás FIFO. Cada documento recibe hasta su saldo. Lo que no
 * alcanza a cruzarse queda fuera del plan (saldo a favor).
 */
export function planCreditAllocation(
  amountCents: number,
  docs: readonly PayableDocRef[],
  relatedKeys: readonly string[] = [],
): CreditAllocation[] {
  const related = new Set(relatedKeys);
  const ordered = sortPayablesFifo(docs.filter((d) => d.outstandingCents > 0));
  const queue = [...ordered.filter((d) => related.has(payableKey(d))), ...ordered.filter((d) => !related.has(payableKey(d)))];
  let left = Math.max(0, Math.trunc(amountCents));
  const out: CreditAllocation[] = [];
  for (const d of queue) {
    if (left <= 0) break;
    const take = Math.min(left, d.outstandingCents);
    if (take <= 0) continue;
    out.push({ kind: d.kind, id: d.id, amountCents: take });
    left -= take;
  }
  return out;
}

/** Σ del plan. */
export function allocatedCents(plan: readonly { amountCents: number }[]): number {
  return plan.reduce((s, a) => s + a.amountCents, 0);
}

export type AllocationError =
  | "amount_invalid"
  | "duplicate_doc"
  | "unknown_doc"
  | "exceeds_balance"
  | "exceeds_available";

/**
 * Valida un plan elegido a mano: montos enteros > 0, cada documento una sola
 * vez, existente entre `docs`, sin pasar su saldo, y Σ ≤ `availableCents`.
 */
export function allocationError(
  plan: readonly CreditAllocation[],
  docs: readonly PayableDocRef[],
  availableCents: number,
): AllocationError | null {
  const byKey = new Map(docs.map((d) => [payableKey(d), d]));
  const seen = new Set<string>();
  for (const a of plan) {
    if (!Number.isInteger(a.amountCents) || a.amountCents <= 0) return "amount_invalid";
    const key = payableKey(a);
    if (seen.has(key)) return "duplicate_doc";
    seen.add(key);
    const doc = byKey.get(key);
    if (!doc) return "unknown_doc";
    if (a.amountCents > doc.outstandingCents) return "exceeds_balance";
  }
  if (allocatedCents(plan) > availableCents) return "exceeds_available";
  return null;
}

/**
 * Vista previa por documento: saldo, lo que baja con el plan y el saldo
 * nuevo (sólo los documentos que el plan toca, en orden FIFO).
 */
export function previewAllocation(
  plan: readonly CreditAllocation[],
  docs: readonly PayableDocRef[],
): Array<PayableDocRef & { appliedCents: number; newOutstandingCents: number }> {
  const amount = new Map(plan.map((a) => [payableKey(a), a.amountCents]));
  return sortPayablesFifo(docs)
    .filter((d) => amount.has(payableKey(d)))
    .map((d) => {
      const appliedCents = amount.get(payableKey(d)) ?? 0;
      return { ...d, appliedCents, newOutstandingCents: d.outstandingCents - appliedCents };
    });
}

/**
 * Notas con saldo a favor que se consumen para cubrir `amountCents` (las más
 * viejas primero): cuánto sale de cada una.
 */
export function drawFromCredits<T extends { id: string; date: string; availableCents: number }>(
  credits: readonly T[],
  amountCents: number,
): Array<{ credit: T; amountCents: number }> {
  const ordered = [...credits]
    .filter((c) => c.availableCents > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  let left = Math.max(0, Math.trunc(amountCents));
  const out: Array<{ credit: T; amountCents: number }> = [];
  for (const c of ordered) {
    if (left <= 0) break;
    const take = Math.min(left, c.availableCents);
    out.push({ credit: c, amountCents: take });
    left -= take;
  }
  return out;
}
