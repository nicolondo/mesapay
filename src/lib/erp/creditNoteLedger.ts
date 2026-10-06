// Contabilidad de las NOTAS CRÉDITO electrónicas — lógica PURA (sin DB).
//
// La capa con Prisma es `creditNoteAccounting.ts`; acá vive la regla para
// poder probarla sin base. Resumen (detalle en docs/electronic-credit-notes.md):
//
//  · DATO: una nota aceptada por la DIAN se lee de su `snapshot.lines` (lo
//    que declaró el XML), nunca del pedido actual. Se agrupa por tarifa
//    (IVA x % / INC x % / sin impuesto) y tiene que cuadrar al centavo con
//    `subtotalCents`, `taxCents` y `totalCents` de la nota; si no cuadra, la
//    nota se excluye (y se loguea) en vez de asentar una cifra inventada.
//  · FECHA FISCAL: el día colombiano del instante de emisión que se firmó
//    (`DianDocument.issuedAt`, el mismo `dianIssueDateTime` del XML).
//  · MES CONTABLE: el mes fiscal si está abierto; si ya está cerrado, el
//    primer mes abierto (cierre + 1). Una vez asentada, la nota queda en ese
//    mes (`postedMonth`) aunque después se cierren o reabran otros.
//  · CONTRAPARTIDA: la parte que cancela cartera de crédito de cliente
//    (`receivableCents`) acredita Clientes; el resto, el pasivo «reintegros
//    por pagar», salvo lo que ya cubrió un reembolso ANTERIOR a la nota.
//  · REEMBOLSOS (por pedido, en orden cronológico): un reembolso posterior
//    a la nota cancela primero ese pasivo; uno anterior ya se asentó como
//    devolución en ventas, así que la nota no vuelve a asentar esa parte.
import { dianIssueDateTime } from "@/lib/dian/dianDateTime";
import type { SalesTaxKind } from "./accounting";

/** Misma regla que `cierre.isMonthClosed` (comparación lexicográfica), sin traer la DB. */
function isMonthClosed(closedThrough: string | null, month: string): boolean {
  return closedThrough != null && month <= closedThrough;
}

// ── Dato contable de la nota ──────────────────────────────────────────────

/** Lo que importa de cada línea del snapshot (`CreditedLine`). */
export type CreditNoteLineInput = {
  /** Base de la línea (sin impuesto). */
  lineTotalCents: number;
  taxCents: number;
  /** Base + impuesto: lo que la nota devuelve de esa línea. */
  grossCents: number;
  /** Tarifa como la declaró el XML ("19.00", "8.00", "0.00"). */
  taxPct: string;
  /** "01" IVA · "04" INC. */
  taxSchemeId: string;
};

export type CreditNoteAmounts = {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  lines: readonly CreditNoteLineInput[];
};

/** Un tramo por tarifa de una nota (o de varias, sumadas). */
export type CreditNoteTaxSlice = {
  kind: SalesTaxKind;
  pct: number;
  baseCents: number;
  taxCents: number;
  /** base + impuesto. */
  grossCents: number;
};

export type CreditNoteSlicesResult =
  | { ok: true; slices: CreditNoteTaxSlice[] }
  | { ok: false; reason: "empty" | "line_mismatch" | "total_mismatch" };

const isCents = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);

/** Tipo y tarifa de una línea: sin tarifa (0 %) ⇒ "none"; "01" IVA; "04" INC. */
export function lineTaxKind(line: Pick<CreditNoteLineInput, "taxPct" | "taxSchemeId">): {
  kind: SalesTaxKind;
  pct: number;
} {
  const pct = Number(line.taxPct);
  if (!Number.isFinite(pct) || pct <= 0) return { kind: "none", pct: 0 };
  return { kind: line.taxSchemeId === "01" ? "iva" : "inc", pct };
}

/** Orden estable de los tramos: IVA, INC, sin impuesto; tarifa mayor primero. */
const KIND_ORDER: Record<SalesTaxKind, number> = { iva: 0, inc: 1, none: 2 };
export function sortSlices<T extends { kind: SalesTaxKind; pct: number }>(slices: T[]): T[] {
  return slices.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.pct - a.pct);
}

/**
 * Tramos por tarifa de UNA nota, validando que cuadre al centavo: cada línea
 * base + impuesto = bruto, Σ bases = `subtotalCents`, Σ impuestos =
 * `taxCents` y Σ base + impuesto = `totalCents`. Si algo no cuadra devuelve
 * `ok: false` y la nota no se contabiliza.
 */
export function creditNoteTaxSlices(note: CreditNoteAmounts): CreditNoteSlicesResult {
  if (!note.lines?.length) return { ok: false, reason: "empty" };
  const byKey = new Map<string, CreditNoteTaxSlice>();
  let base = 0;
  let tax = 0;
  for (const line of note.lines) {
    if (
      !isCents(line.lineTotalCents) ||
      !isCents(line.taxCents) ||
      !isCents(line.grossCents) ||
      line.taxCents < 0 ||
      line.lineTotalCents + line.taxCents !== line.grossCents
    ) {
      return { ok: false, reason: "line_mismatch" };
    }
    const { kind, pct } = lineTaxKind(line);
    if (kind === "none" && line.taxCents !== 0) return { ok: false, reason: "line_mismatch" };
    const key = `${kind}:${pct}`;
    const slice = byKey.get(key) ?? { kind, pct, baseCents: 0, taxCents: 0, grossCents: 0 };
    slice.baseCents += line.lineTotalCents;
    slice.taxCents += line.taxCents;
    slice.grossCents += line.grossCents;
    byKey.set(key, slice);
    base += line.lineTotalCents;
    tax += line.taxCents;
  }
  if (base !== note.subtotalCents || tax !== note.taxCents || base + tax !== note.totalCents) {
    return { ok: false, reason: "total_mismatch" };
  }
  return { ok: true, slices: sortSlices([...byKey.values()]) };
}

/** Suma tramos de varias notas por tarifa. */
export function sumSlices(groups: readonly (readonly CreditNoteTaxSlice[])[]): CreditNoteTaxSlice[] {
  const byKey = new Map<string, CreditNoteTaxSlice>();
  for (const slices of groups) {
    for (const s of slices) {
      const key = `${s.kind}:${s.pct}`;
      const acc = byKey.get(key) ?? { kind: s.kind, pct: s.pct, baseCents: 0, taxCents: 0, grossCents: 0 };
      acc.baseCents += s.baseCents;
      acc.taxCents += s.taxCents;
      acc.grossCents += s.grossCents;
      byKey.set(key, acc);
    }
  }
  return sortSlices([...byKey.values()]);
}

/**
 * Reparte `keepGrossCents` (≤ bruto de la nota) entre los tramos en
 * proporción a su bruto (resto mayor, así la suma es exacta) y, dentro de
 * cada tramo, el impuesto en la misma proporción. Se usa cuando parte de la
 * nota ya la asentó un reembolso anterior.
 */
export function prorateSlices(
  slices: readonly CreditNoteTaxSlice[],
  keepGrossCents: number,
): CreditNoteTaxSlice[] {
  const total = slices.reduce((s, x) => s + x.grossCents, 0);
  if (keepGrossCents >= total) return slices.map((s) => ({ ...s }));
  if (keepGrossCents <= 0 || total <= 0) return [];
  const shares = slices.map((s, i) => {
    const exact = (s.grossCents * keepGrossCents) / total;
    return { i, floor: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = keepGrossCents - shares.reduce((s, x) => s + x.floor, 0);
  for (const sh of [...shares].sort((a, b) => b.rest - a.rest || a.i - b.i)) {
    if (left <= 0) break;
    sh.floor += 1;
    left -= 1;
  }
  return shares
    .map(({ i, floor }) => {
      const s = slices[i]!;
      const taxCents = s.grossCents > 0 ? Math.round((s.taxCents * floor) / s.grossCents) : 0;
      return { kind: s.kind, pct: s.pct, grossCents: floor, taxCents, baseCents: floor - taxCents };
    })
    .filter((s) => s.grossCents > 0);
}

// ── Fechas y mes contable ─────────────────────────────────────────────────

/** Fecha FISCAL de la nota ("YYYY-MM-DD", hora de Colombia) desde su `issuedAt`. */
export function creditNoteFiscalDate(issuedAt: Date): string {
  return dianIssueDateTime(issuedAt).date;
}

/** "YYYY-MM-DD" → "YYYY-MM". */
export function monthOfIsoDate(date: string): string {
  return date.slice(0, 7);
}

/** "2026-12" → "2027-01". */
export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y!, m!, 1));
  return d.toISOString().slice(0, 7);
}

/**
 * Mes en el que se asienta una nota TODAVÍA no asentada: su mes fiscal si
 * está abierto; si el mes fiscal ya está cerrado, el primer mes abierto
 * (el siguiente a `closedThrough`). Un mes cerrado tiene comprobantes
 * numerados en firme y no recibe asientos nuevos (misma regla que la
 * reversa de comprobantes, `journalManual.reversalDate`).
 */
export function creditNoteTargetMonth(fiscalMonth: string, closedThrough: string | null): string {
  return isMonthClosed(closedThrough, fiscalMonth) ? nextMonth(closedThrough!) : fiscalMonth;
}

/** ¿Entra la nota en el asiento del mes `month`? */
export function belongsToMonth(
  note: { postedMonth: string | null; fiscalMonth: string },
  month: string,
  closedThrough: string | null,
): boolean {
  if (note.postedMonth) return note.postedMonth === month;
  return creditNoteTargetMonth(note.fiscalMonth, closedThrough) === month;
}

/** Lo que la pantalla de la nota muestra de su contabilización. */
export type CreditNoteAccountingStatus =
  /** Ya está en el asiento «Notas crédito del mes» de `month`. */
  | { status: "posted"; month: string }
  /** Se asienta en `month` (su mes fiscal, abierto) al generar el diario. */
  | { status: "pending"; month: string }
  /** Su mes fiscal está cerrado: se asienta en `month`, el primer mes abierto. */
  | { status: "pending_closed"; month: string; fiscalMonth: string };

export function creditNoteAccountingStatus(args: {
  postedMonth: string | null;
  fiscalMonth: string;
  closedThrough: string | null;
}): CreditNoteAccountingStatus {
  if (args.postedMonth) return { status: "posted", month: args.postedMonth };
  const month = creditNoteTargetMonth(args.fiscalMonth, args.closedThrough);
  return month === args.fiscalMonth
    ? { status: "pending", month }
    : { status: "pending_closed", month, fiscalMonth: args.fiscalMonth };
}

// ── Cartera de crédito de cliente ─────────────────────────────────────────

/**
 * Parte de una nota que cancela cartera: hasta el saldo pendiente (FIFO) de
 * los cargos a crédito de la cuenta, en orden cronológico. Si el cliente ya
 * pagó la cuenta, la nota no puede bajar una deuda que no existe: lo que
 * sobra va al pasivo con el cliente.
 */
export function allocateReceivable(
  totalCents: number,
  charges: readonly { id: string; outstandingCents: number }[],
): { receivableCents: number; perCharge: { id: string; cents: number }[] } {
  let left = Math.max(0, totalCents);
  const perCharge: { id: string; cents: number }[] = [];
  for (const c of charges) {
    if (left <= 0) break;
    const take = Math.min(left, Math.max(0, c.outstandingCents));
    if (take <= 0) continue;
    perCharge.push({ id: c.id, cents: take });
    left -= take;
  }
  return { receivableCents: totalCents - left, perCharge };
}

// ── Notas y reembolsos de un mismo pedido ─────────────────────────────────

export type OrderNoteEvent = {
  id: string;
  /** Instante fiscal de la nota (`issuedAt`). */
  at: Date;
  /** Lo que la nota le reconoce al cliente fuera de cartera: total − receivableCents. */
  availableCents: number;
};

export type OrderRefundEvent = { id: string; at: Date; amountCents: number };

export type OrderMatch = {
  notes: Map<string, { coveredByPriorRefundsCents: number; liabilityCents: number }>;
  refunds: Map<string, { liabilityDebitCents: number; coveredByLaterNoteCents: number }>;
};

/**
 * Cruza en orden cronológico las notas y los reembolsos de UN pedido (a
 * igual instante, la nota primero):
 *  · nota: lo que no cubre cartera primero se cruza con reembolsos
 *    ANTERIORES todavía sin nota (ya asentados como devolución: la nota no
 *    los repite) y el resto queda como pasivo «reintegros por pagar»;
 *  · reembolso: cancela primero ese pasivo abierto (no vuelve a debitar
 *    devoluciones); lo que sobra es una devolución sin nota, como antes.
 * Determinístico: el resultado no depende de cuándo se regenere el mes.
 */
export function matchOrderNotesAndRefunds(
  notes: readonly OrderNoteEvent[],
  refunds: readonly OrderRefundEvent[],
): OrderMatch {
  type Ev = { type: "note"; e: OrderNoteEvent } | { type: "refund"; e: OrderRefundEvent };
  const events: Ev[] = [
    ...notes.map((e) => ({ type: "note" as const, e })),
    ...refunds.map((e) => ({ type: "refund" as const, e })),
  ].sort(
    (a, b) =>
      a.e.at.getTime() - b.e.at.getTime() ||
      (a.type === b.type ? 0 : a.type === "note" ? -1 : 1) ||
      a.e.id.localeCompare(b.e.id),
  );
  const out: OrderMatch = { notes: new Map(), refunds: new Map() };
  let openLiability = 0;
  const pending: { id: string; left: number }[] = [];
  for (const ev of events) {
    if (ev.type === "note") {
      const available = Math.max(0, ev.e.availableCents);
      let covered = 0;
      while (covered < available && pending.length > 0) {
        const head = pending[0]!;
        const take = Math.min(available - covered, head.left);
        head.left -= take;
        covered += take;
        out.refunds.get(head.id)!.coveredByLaterNoteCents += take;
        if (head.left === 0) pending.shift();
      }
      const liability = available - covered;
      openLiability += liability;
      out.notes.set(ev.e.id, { coveredByPriorRefundsCents: covered, liabilityCents: liability });
    } else {
      const amount = Math.max(0, ev.e.amountCents);
      const matched = Math.min(amount, openLiability);
      openLiability -= matched;
      out.refunds.set(ev.e.id, { liabilityDebitCents: matched, coveredByLaterNoteCents: 0 });
      if (amount - matched > 0) pending.push({ id: ev.e.id, left: amount - matched });
    }
  }
  return out;
}

/** Parte de un reembolso que quedó ligada a una nota (antes o después). */
export function refundLinkedCents(
  match: OrderMatch,
  refundId: string,
): number {
  const r = match.refunds.get(refundId);
  return r ? r.liabilityDebitCents + r.coveredByLaterNoteCents : 0;
}

// ── Montos del asiento ────────────────────────────────────────────────────

export type CreditNotePosting = {
  id: string;
  /** Tramos a asentar (ya sin la parte cubierta por reembolsos anteriores). */
  slices: CreditNoteTaxSlice[];
  /** Crédito a Clientes (130505). */
  receivableCents: number;
  /** Crédito al pasivo «reintegros por pagar» (238020). */
  liabilityCents: number;
};

/**
 * Lo que una nota aporta al asiento del mes. `slices` son los tramos
 * COMPLETOS de la nota; `coveredByPriorRefundsCents` (de
 * `matchOrderNotesAndRefunds`) se descuenta prorrateado. Cuadra por
 * construcción: Σ tramos asentados = receivable + pasivo.
 */
export function creditNotePosting(args: {
  id: string;
  slices: readonly CreditNoteTaxSlice[];
  totalCents: number;
  receivableCents: number;
  coveredByPriorRefundsCents: number;
}): CreditNotePosting {
  const receivable = Math.min(Math.max(0, args.receivableCents), args.totalCents);
  const covered = Math.min(Math.max(0, args.coveredByPriorRefundsCents), args.totalCents - receivable);
  const keep = args.totalCents - covered;
  return {
    id: args.id,
    slices: prorateSlices(args.slices, keep),
    receivableCents: receivable,
    liabilityCents: keep - receivable,
  };
}
