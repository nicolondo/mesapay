// «Pagar a proveedor» — plan de un comprobante de egreso (LÓGICA PURA: la
// usan la vista previa del formulario y el servidor, que lo recalcula bajo
// candado con los saldos frescos).
//
// Orden, como se acordó con el dueño:
//  1. Primero se cruzan los SALDOS A FAVOR elegidos (notas crédito y
//     anticipos): cada nota que RELACIONA facturas baja primero esas; lo que
//     le sobre —y las que no relacionan ninguna (acuerdos, rebajas,
//     anticipos)— va FIFO a las demás facturas, en el orden de la lista.
//  2. Después el DINERO, FIFO en el orden de la lista (por defecto: vence
//     antes, luego la más vieja; el operador puede reordenar o desmarcar).
//  3. Si el dinero supera lo que queda por pagar, el excedente es un
//     ANTICIPO del proveedor (133005) que consumen sus facturas siguientes.
import { payableKey, type PayableDocKind, type PayableDocRef } from "./supplierCreditAllocation";

export type PaymentCreditSource = "note" | "advance";

/** Un saldo a favor que se puede cruzar en el pago. */
export type PaymentCredit = {
  source: PaymentCreditSource;
  id: string;
  /** Número de la nota o del comprobante del anticipo (para mostrar). */
  label: string;
  /** yyyy-mm-dd */
  date: string;
  availableCents: number;
  /** Facturas que la nota relaciona (`payableKey`); vacío en anticipos. */
  relatedKeys: string[];
};

export function creditKey(c: { source: PaymentCreditSource; id: string }): string {
  return `${c.source}:${c.id}`;
}

export type PlannedDoc = PayableDocRef & {
  creditCents: number;
  moneyCents: number;
  newOutstandingCents: number;
};

export type PaymentPlan = {
  docs: PlannedDoc[];
  /** Cruces: de qué saldo a favor, a qué documento y cuánto. */
  creditUses: Array<{ source: PaymentCreditSource; creditId: string; kind: PayableDocKind; docId: string; amountCents: number }>;
  /** Dinero aplicado a cada documento. */
  moneyUses: Array<{ kind: PayableDocKind; id: string; amountCents: number }>;
  totals: {
    /** Σ saldo de las facturas elegidas. */
    pendingCents: number;
    /** Σ saldos a favor cruzados. */
    creditsCents: number;
    /** pendiente − cruces: lo que habría que pagar para dejarlas en cero. */
    netToPayCents: number;
    /** Dinero del comprobante. */
    payingCents: number;
    /** Dinero aplicado a facturas. */
    appliedMoneyCents: number;
    /** Excedente → anticipo. */
    advanceCents: number;
    /** Lo que queda debiendo de las facturas elegidas. */
    leftUnpaidCents: number;
  };
};

/**
 * Plan del comprobante. `docs` y `credits` ya vienen filtrados (sólo los
 * marcados) y en el orden en que se aplican.
 */
export function planSupplierPayment(input: {
  docs: readonly PayableDocRef[];
  credits: readonly PaymentCredit[];
  amountCents: number;
}): PaymentPlan {
  const docs = input.docs.filter((d) => d.outstandingCents > 0);
  const remaining = new Map(docs.map((d) => [payableKey(d), d.outstandingCents]));
  const credit = new Map(docs.map((d) => [payableKey(d), 0]));
  const money = new Map(docs.map((d) => [payableKey(d), 0]));
  const creditUses: PaymentPlan["creditUses"] = [];
  const left = new Map(input.credits.map((c) => [creditKey(c), Math.max(0, c.availableCents)]));

  const cross = (c: PaymentCredit, d: PayableDocRef) => {
    const k = payableKey(d);
    const take = Math.min(left.get(creditKey(c)) ?? 0, remaining.get(k) ?? 0);
    if (take <= 0) return;
    left.set(creditKey(c), (left.get(creditKey(c)) ?? 0) - take);
    remaining.set(k, (remaining.get(k) ?? 0) - take);
    credit.set(k, (credit.get(k) ?? 0) + take);
    const prev = creditUses.find((u) => u.source === c.source && u.creditId === c.id && u.kind === d.kind && u.docId === d.id);
    if (prev) prev.amountCents += take;
    else creditUses.push({ source: c.source, creditId: c.id, kind: d.kind, docId: d.id, amountCents: take });
  };

  // 1a. Notas con facturas relacionadas: a esas primero.
  for (const c of input.credits) {
    if (c.relatedKeys.length === 0) continue;
    for (const d of docs) if (c.relatedKeys.includes(payableKey(d))) cross(c, d);
  }
  // 1b. Lo que sobra de cada saldo a favor (y los que no relacionan nada): FIFO.
  for (const c of input.credits) for (const d of docs) cross(c, d);

  // 2. El dinero, FIFO.
  let cash = Math.max(0, Math.trunc(input.amountCents));
  const moneyUses: PaymentPlan["moneyUses"] = [];
  for (const d of docs) {
    if (cash <= 0) break;
    const k = payableKey(d);
    const take = Math.min(cash, remaining.get(k) ?? 0);
    if (take <= 0) continue;
    cash -= take;
    remaining.set(k, (remaining.get(k) ?? 0) - take);
    money.set(k, take);
    moneyUses.push({ kind: d.kind, id: d.id, amountCents: take });
  }

  const pendingCents = docs.reduce((s, d) => s + d.outstandingCents, 0);
  const creditsCents = creditUses.reduce((s, u) => s + u.amountCents, 0);
  const appliedMoneyCents = moneyUses.reduce((s, u) => s + u.amountCents, 0);
  const payingCents = Math.max(0, Math.trunc(input.amountCents));
  return {
    docs: docs.map((d) => {
      const k = payableKey(d);
      return {
        ...d,
        creditCents: credit.get(k) ?? 0,
        moneyCents: money.get(k) ?? 0,
        newOutstandingCents: remaining.get(k) ?? 0,
      };
    }),
    creditUses,
    moneyUses,
    totals: {
      pendingCents,
      creditsCents,
      netToPayCents: pendingCents - creditsCents,
      payingCents,
      appliedMoneyCents,
      advanceCents: payingCents - appliedMoneyCents,
      leftUnpaidCents: pendingCents - creditsCents - appliedMoneyCents,
    },
  };
}

/** Medios de pago del comprobante (se guardan como código; la UI los traduce). */
export const SUPPLIER_PAYMENT_METHODS = ["transfer", "cash", "check", "card", "other"] as const;
export type SupplierPaymentMethod = (typeof SUPPLIER_PAYMENT_METHODS)[number];

export function isSupplierPaymentMethod(v: unknown): v is SupplierPaymentMethod {
  return typeof v === "string" && (SUPPLIER_PAYMENT_METHODS as readonly string[]).includes(v);
}

/** «CE-0007». */
export function voucherNumberLabel(n: number): string {
  return `CE-${String(n).padStart(4, "0")}`;
}
