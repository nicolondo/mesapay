/**
 * Libro mayor (lógica pura). Portado de zenith `contabilidad/mayor/page.tsx`
 * — con la corrección del tipo `costo` (en zenith el set de naturaleza
 * débito decía `costos` y las cuentas de costo salían al revés).
 *
 * Por cuenta: saldo inicial A NATURALEZA con las líneas anteriores al
 * `desde` (débito natural → D − C; crédito natural → C − D), Debe/Haber del
 * rango y balance = inicial ± movimiento según naturaleza. Los movimientos
 * van en orden `fecha, comprobante, createdAt` con saldo corrido.
 * Solo salen las cuentas con movimiento en el rango o saldo inicial ≠ 0
 * (salvo la cuenta pedida explícitamente, que sale aunque esté en cero).
 *
 * Los asientos ANULADOS suman igual que los demás: la anulación es por
 * reversa (el original queda `annulled` con sus líneas vigentes y un
 * asiento `manual` invertido las netea), así que original + reversa = 0
 * en la cuenta. Solo se MARCAN (`voided`) para que la vista los rotule.
 */

/** Estado del asiento anulado por reversa (PR de comprobantes). */
export const ANNULLED_STATUS = "annulled";

/** ¿Es un asiento anulado? Se apoya en `status`, no en `annulledAt`. */
export function isAnnulled(status: string | null | undefined): boolean {
  return status === ANNULLED_STATUS;
}

export type LedgerLineInput = {
  id: string;
  entryId: string;
  date: Date | string;
  voucherNumber: number | null;
  source: string;
  memo: string | null;
  /** Estado del asiento (`posted` | `annulled`); ausente = vigente. */
  status?: string | null;
  createdAt: Date | string;
  accountCode: string;
  debitCents: number;
  creditCents: number;
  /** Detalle propio de la línea (si lo hay). */
  lineMemo?: string | null;
};

export type LedgerAccountInput = {
  code: string;
  name: string;
  type?: string | null;
  nature?: string | null;
};

export type LedgerMovement = {
  id: string;
  entryId: string;
  /** ISO completo del asiento (la vista lo formatea en UTC). */
  date: string;
  voucherNumber: number | null;
  source: string;
  memo: string | null;
  /** Asiento anulado por reversa: suma igual, se rotula «Anulado». */
  voided: boolean;
  debitCents: number;
  creditCents: number;
  /** Saldo corrido a naturaleza tras este movimiento. */
  runningCents: number;
};

export type GeneralLedgerAccount = {
  code: string;
  name: string;
  nature: "debito" | "credito";
  initialCents: number;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
  movements: LedgerMovement[];
};

export type GeneralLedger = {
  accounts: GeneralLedgerAccount[];
  totals: { debitCents: number; creditCents: number };
  /** Σ débitos del rango = Σ créditos del rango (±1 centavo). */
  balanced: boolean;
};

const DEBIT_TYPES = new Set(["activo", "gasto", "costo"]);
const DEBIT_CLASSES = new Set(["1", "5", "6", "7", "8"]);

/**
 * Naturaleza de la cuenta: manda la columna `nature` del plan; si falta,
 * el tipo; si tampoco, la clase del código (Decreto 2650).
 */
export function accountNature(a: {
  code: string;
  type?: string | null;
  nature?: string | null;
}): "debito" | "credito" {
  if (a.nature === "debito" || a.nature === "credito") return a.nature;
  if (a.type) return DEBIT_TYPES.has(a.type) ? "debito" : "credito";
  return DEBIT_CLASSES.has(a.code.slice(0, 1)) ? "debito" : "credito";
}

function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d);
}

/** Orden de los movimientos: fecha, número de comprobante (sin numerar al final), creación. */
export function compareMovements(
  a: { date: Date; voucherNumber: number | null; createdAt: Date },
  b: { date: Date; voucherNumber: number | null; createdAt: Date },
): number {
  const d = a.date.getTime() - b.date.getTime();
  if (d !== 0) return d;
  const va = a.voucherNumber ?? Number.POSITIVE_INFINITY;
  const vb = b.voucherNumber ?? Number.POSITIVE_INFINITY;
  if (va !== vb) return va < vb ? -1 : 1;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

export function buildGeneralLedger(
  lines: readonly LedgerLineInput[],
  accounts: readonly LedgerAccountInput[],
  {
    from,
    to,
    accountCode,
  }: {
    /** Inicio del rango (inclusivo). */
    from: Date;
    /** Fin del rango (EXCLUSIVO). */
    to: Date;
    accountCode?: string | null;
  },
): GeneralLedger {
  const chart = new Map<string, LedgerAccountInput>();
  for (const a of accounts) chart.set(a.code, a);

  type Acc = {
    meta: LedgerAccountInput;
    natural: boolean;
    initial: number;
    debe: number;
    haber: number;
    raw: { line: LedgerLineInput; date: Date; createdAt: Date }[];
  };
  const byCode = new Map<string, Acc>();
  const accFor = (code: string): Acc => {
    let acc = byCode.get(code);
    if (!acc) {
      const meta = chart.get(code) ?? { code, name: "" };
      acc = {
        meta,
        natural: accountNature(meta) === "debito",
        initial: 0,
        debe: 0,
        haber: 0,
        raw: [],
      };
      byCode.set(code, acc);
    }
    return acc;
  };

  for (const l of lines) {
    if (accountCode && l.accountCode !== accountCode) continue;
    const date = toDate(l.date);
    if (date >= to) continue;
    const acc = accFor(l.accountCode);
    if (date < from) {
      acc.initial += acc.natural ? l.debitCents - l.creditCents : l.creditCents - l.debitCents;
      continue;
    }
    acc.debe += l.debitCents;
    acc.haber += l.creditCents;
    acc.raw.push({ line: l, date, createdAt: toDate(l.createdAt) });
  }
  if (accountCode) accFor(accountCode);

  const out: GeneralLedgerAccount[] = [];
  let totalDebe = 0;
  let totalHaber = 0;
  for (const code of [...byCode.keys()].sort()) {
    const acc = byCode.get(code)!;
    const hasMovement = acc.raw.length > 0 || acc.initial !== 0;
    if (!hasMovement && code !== accountCode) continue;
    acc.raw.sort((a, b) =>
      compareMovements(
        { date: a.date, voucherNumber: a.line.voucherNumber, createdAt: a.createdAt },
        { date: b.date, voucherNumber: b.line.voucherNumber, createdAt: b.createdAt },
      ),
    );
    let running = acc.initial;
    const movements: LedgerMovement[] = acc.raw.map(({ line, date }) => {
      running += acc.natural
        ? line.debitCents - line.creditCents
        : line.creditCents - line.debitCents;
      return {
        id: line.id,
        entryId: line.entryId,
        date: date.toISOString(),
        voucherNumber: line.voucherNumber,
        source: line.source,
        memo: line.lineMemo ?? line.memo,
        voided: isAnnulled(line.status),
        debitCents: line.debitCents,
        creditCents: line.creditCents,
        runningCents: running,
      };
    });
    totalDebe += acc.debe;
    totalHaber += acc.haber;
    out.push({
      code,
      name: acc.meta.name,
      nature: acc.natural ? "debito" : "credito",
      initialCents: acc.initial,
      debitCents: acc.debe,
      creditCents: acc.haber,
      balanceCents: acc.natural
        ? acc.initial + acc.debe - acc.haber
        : acc.initial + acc.haber - acc.debe,
      movements,
    });
  }

  return {
    accounts: out,
    totals: { debitCents: totalDebe, creditCents: totalHaber },
    // Con una sola cuenta filtrada el cuadre no aplica (se compara consigo misma).
    balanced: accountCode ? true : Math.abs(totalDebe - totalHaber) <= 1,
  };
}

/** `#000123`; null → etiqueta «sin numerar» que pone la vista. */
export function formatVoucherNumber(n: number | null | undefined): string | null {
  return n == null ? null : `#${String(n).padStart(6, "0")}`;
}

/**
 * Filas del CSV: Cuenta, Nombre, Fecha, Comprobante, Origen, Descripción,
 * Debe, Haber, Saldo. La primera fila de cada cuenta es su saldo inicial;
 * un movimiento anulado lleva la marca al frente de la descripción.
 */
export function generalLedgerCsvRows(
  ledger: GeneralLedger,
  labels: {
    initial: string;
    unnumbered: string;
    voided: string;
    sourceLabel: (source: string) => string;
  },
): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const a of ledger.accounts) {
    rows.push([a.code, a.name, "", "", "", labels.initial, 0, 0, a.initialCents]);
    for (const m of a.movements) {
      rows.push([
        a.code,
        a.name,
        m.date.slice(0, 10),
        formatVoucherNumber(m.voucherNumber) ?? labels.unnumbered,
        labels.sourceLabel(m.source),
        [m.voided ? labels.voided : null, m.memo].filter(Boolean).join(" · "),
        m.debitCents,
        m.creditCents,
        m.runningCents,
      ]);
    }
  }
  return rows;
}
