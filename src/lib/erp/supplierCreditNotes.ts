// Notas crédito de PROVEEDORES — lógica PURA (sin DB ni React).
//
// ── Qué es ────────────────────────────────────────────────────────────────
// El proveedor disminuye lo que se le debe. Cuatro tipos, cada uno con su
// contrapartida contable por defecto (el operador puede elegir otra cuenta
// en la nota; el contador puede abrir auxiliares debajo de las del motor):
//
//  · agreement             Acuerdo comercial: bonificación por volumen,
//                          metas o convenio con el proveedor → 613575
//                          (contra-costo propio; renglón aparte en el PYG).
//  · discount              Descuento comercial o rebaja puntual → 613570
//                          (contra-costo). NIIF PYMES 13.6: los descuentos y
//                          rebajas se restan del costo de adquisición; como
//                          en un restaurante esa mercancía casi siempre ya se
//                          consumió y el kardex no se revaloriza, va al costo
//                          de ventas y no al inventario.
//  · conditional_discount  Descuento condicionado / pronto pago → 421040
//                          (ingreso financiero, «Descuentos comerciales
//                          condicionados»).
//  · return                Devolución de mercancía → 1435 inventario (sale
//                          del kardex al costo que acredita la nota) o el
//                          gasto, si el insumo no se lleva en inventario.
//
// ── Impuestos ─────────────────────────────────────────────────────────────
// Una nota electrónica (CUDE) es válida aunque no relacione factura. Si NO
// discrimina IVA, el proveedor no redujo su IVA y nosotros tampoco: el valor
// completo es el descuento. Si lo discrimina, baja el IVA descontable
// (24081001) — o, si el comercio no descuenta IVA de compras (foto
// `ivaDeductible`), sigue a la base, porque ese IVA fue costo. El INC
// discriminado siempre sigue a la base (en compras el INC es costo).
//
// ── Asientos (posting.ts, bloque 9) ───────────────────────────────────────
//  Nota:        D 133005 saldo a favor (total) · C contrapartida · C IVA desc.
//  Cruce:       D 220505 proveedores (compra) / 233505 (gasto) · C 133005
//  Reintegro:   D caja/banco · C 133005
//  Anulación:   el reverso exacto de la nota, el día que se anula (los
//               cruces se deshacen borrándolos; ver supplierCreditNoteService).
// Así lo no cruzado queda VISIBLE como saldo a favor del proveedor (activo,
// 1330) y nunca como un saldo débito escondido en Proveedores.
import { ENGINE } from "./engineCodes";

export const SUPPLIER_CREDIT_NOTE_KINDS = ["agreement", "discount", "conditional_discount", "return"] as const;
export type SupplierCreditNoteKind = (typeof SUPPLIER_CREDIT_NOTE_KINDS)[number];

export function isSupplierCreditNoteKind(v: unknown): v is SupplierCreditNoteKind {
  return typeof v === "string" && (SUPPLIER_CREDIT_NOTE_KINDS as readonly string[]).includes(v);
}

/** Clave i18n (`opSupplierCredit`) del nombre de cada tipo. */
export const KIND_LABEL_KEY: Record<SupplierCreditNoteKind, string> = {
  agreement: "kindAgreement",
  discount: "kindDiscount",
  conditional_discount: "kindConditional",
  return: "kindReturn",
};

/** Contrapartida por defecto de cada tipo (código base del motor). */
export function defaultCreditNoteAccount(kind: SupplierCreditNoteKind): string {
  switch (kind) {
    case "agreement":
      return ENGINE.ACUERDOS_COMERCIALES;
    case "discount":
      return ENGINE.DESCUENTOS_COMPRAS;
    case "conditional_discount":
      return ENGINE.DESCUENTOS_CONDICIONADOS;
    case "return":
      return ENGINE.INVENTARIO;
  }
}

/**
 * ¿Se puede elegir otra contrapartida para este tipo? Las devoluciones NO:
 * su crédito a inventario tiene que ser exactamente lo que sale del kardex.
 */
export function accountIsConfigurable(kind: SupplierCreditNoteKind): boolean {
  return kind !== "return";
}

/** Clase PUC válida para la contrapartida elegida: costo (6), gasto (5) o ingreso (4). */
export function isValidContraAccountCode(code: string): boolean {
  return /^[456]\d{3,}$/.test(code);
}

// ─── Montos ──────────────────────────────────────────────────────────────

export type CreditNoteLineAmount = {
  /** Valor de la línea SIN IVA. */
  valueCents: number;
  /** Costo congelado al registrar (valor + impuesto que es costo). 0/ausente = se calcula. */
  costCents?: number | null;
  /** ¿Sale del kardex? (insumo con inventario al registrar). */
  inventoried: boolean;
};

export type CreditNoteAmounts = {
  kind: SupplierCreditNoteKind;
  /** Valor total de la nota (lo que baja la cuenta por pagar). */
  totalCents: number;
  ivaCents: number;
  incCents: number;
  /** Foto de `purchaseIvaDeductible` al registrar. */
  ivaDeductible: boolean;
  /** Contrapartida elegida (null = la del tipo). */
  accountCode?: string | null;
  /** Sólo devoluciones. */
  lines?: readonly CreditNoteLineAmount[];
};

/** Base de la nota: total − IVA − INC. */
export function creditNoteBaseCents(n: Pick<CreditNoteAmounts, "totalCents" | "ivaCents" | "incCents">): number {
  return n.totalCents - n.ivaCents - n.incCents;
}

/** IVA que va al descontable (0 si no viene discriminado o no es descontable). */
export function deductibleIvaCents(n: Pick<CreditNoteAmounts, "ivaCents" | "ivaDeductible">): number {
  return n.ivaDeductible && n.ivaCents > 0 ? n.ivaCents : 0;
}

export type CreditNoteAmountError =
  | "total_invalid"
  | "tax_invalid"
  | "base_invalid"
  | "lines_required"
  | "lines_mismatch"
  | "line_invalid";

/**
 * Valida los montos: total > 0, impuestos ≥ 0 y base > 0; una devolución
 * trae líneas y la suma de sus valores es exactamente la base.
 */
export function creditNoteAmountError(n: CreditNoteAmounts): CreditNoteAmountError | null {
  if (!Number.isInteger(n.totalCents) || n.totalCents <= 0) return "total_invalid";
  if (!Number.isInteger(n.ivaCents) || n.ivaCents < 0 || !Number.isInteger(n.incCents) || n.incCents < 0) {
    return "tax_invalid";
  }
  const base = creditNoteBaseCents(n);
  if (base <= 0) return "base_invalid";
  if (n.kind === "return") {
    const lines = n.lines ?? [];
    if (lines.length === 0) return "lines_required";
    if (lines.some((l) => !Number.isInteger(l.valueCents) || l.valueCents <= 0)) return "line_invalid";
    if (lines.reduce((s, l) => s + l.valueCents, 0) !== base) return "lines_mismatch";
  }
  return null;
}

/**
 * Reparte `total` en proporción a `weights` con enteros exactos (mayor
 * residuo): Σ partes == total siempre.
 */
export function allocateProRata(total: number, weights: readonly number[]): number[] {
  const whole = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (weights.length === 0) return [];
  if (whole <= 0 || total === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * Math.max(0, w)) / whole);
  const parts = raw.map((r) => Math.floor(r));
  let rest = total - parts.reduce((s, p) => s + p, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) parts[order[k]!.i]! += 1;
  return parts;
}

/**
 * Costo de cada línea de una devolución: su valor más la parte que le toca
 * del impuesto que es costo (INC y, si no es descontable, el IVA). Es lo que
 * sale del kardex y lo que el asiento acredita a 1435: los dos cuadran.
 */
export function returnLineCosts(n: CreditNoteAmounts): number[] {
  const lines = n.lines ?? [];
  // Notas ya registradas: el costo congelado (lo que salió del kardex).
  if (lines.length > 0 && lines.every((l) => (l.costCents ?? 0) > 0)) return lines.map((l) => l.costCents!);
  const costTax = n.incCents + (n.ivaCents - deductibleIvaCents(n));
  const shares = allocateProRata(costTax, lines.map((l) => l.valueCents));
  return lines.map((l, i) => l.valueCents + shares[i]!);
}

// ─── Asiento ─────────────────────────────────────────────────────────────

export type PostingLine = { code: string; debit?: number; credit?: number; memo?: string };

/**
 * Créditos de UNA nota (contrapartida + IVA descontable); suman el total.
 * Las devoluciones parten entre inventario (insumos con kardex) y gasto
 * (los que no se llevan en inventario, como la compra que los trajo).
 */
export function creditNoteContraLines(n: CreditNoteAmounts): PostingLine[] {
  const iva = deductibleIvaCents(n);
  const out: PostingLine[] = [];
  if (n.kind === "return") {
    const costs = returnLineCosts(n);
    const lines = n.lines ?? [];
    let inventory = 0;
    let expense = 0;
    lines.forEach((l, i) => {
      if (l.inventoried) inventory += costs[i]!;
      else expense += costs[i]!;
    });
    if (inventory > 0) out.push({ code: ENGINE.INVENTARIO, credit: inventory });
    if (expense > 0) out.push({ code: ENGINE.GASTOS_DIVERSOS, credit: expense });
  } else {
    const amount = n.totalCents - iva;
    if (amount > 0) out.push({ code: n.accountCode || defaultCreditNoteAccount(n.kind), credit: amount });
  }
  if (iva > 0) out.push({ code: ENGINE.IVA_DESCONTABLE, credit: iva });
  return out;
}

/** Asiento completo de una nota: D saldo a favor (total) · C contrapartidas. */
export function creditNotePostingLines(n: CreditNoteAmounts): PostingLine[] {
  return [{ code: ENGINE.SALDO_A_FAVOR_PROVEEDORES, debit: n.totalCents }, ...creditNoteContraLines(n)];
}

/** Invierte débitos y créditos (anulación). */
export function reversePostingLines(lines: readonly PostingLine[]): PostingLine[] {
  return lines.map((l) => ({
    code: l.code,
    ...(l.credit ? { debit: l.credit } : {}),
    ...(l.debit ? { credit: l.debit } : {}),
    ...(l.memo ? { memo: l.memo } : {}),
  }));
}

/**
 * Suma líneas por cuenta y deja UNA línea por cuenta con el neto (débito si
 * es positivo, crédito si es negativo). Cuadra si las entradas cuadran.
 */
export function netPostingLines(lines: readonly PostingLine[]): PostingLine[] {
  const net = new Map<string, number>();
  for (const l of lines) net.set(l.code, (net.get(l.code) ?? 0) + (l.debit ?? 0) - (l.credit ?? 0));
  const out: PostingLine[] = [];
  for (const [code, cents] of net) {
    if (cents > 0) out.push({ code, debit: cents });
    else if (cents < 0) out.push({ code, credit: -cents });
  }
  // Débitos primero, como los demás asientos del motor.
  return out.sort((a, b) => (b.debit ?? 0) - (a.debit ?? 0));
}

// ─── Saldos de la nota ───────────────────────────────────────────────────

export type CreditNoteUsage = {
  totalCents: number;
  /** Σ cruces con compras y gastos. */
  appliedCents: number;
  /** Σ reintegros en dinero. */
  refundedCents: number;
};

/** Saldo a favor que le queda a la nota (0 si está anulada). */
export function creditNoteAvailableCents(n: CreditNoteUsage & { status?: string | null }): number {
  if (n.status === "voided") return 0;
  return Math.max(0, n.totalCents - n.appliedCents - n.refundedCents);
}
