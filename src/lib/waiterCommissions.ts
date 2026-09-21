/**
 * ===== COMISIONES DE VENTAS POR MESERO — modelo puro =====
 *
 * Portado de zenith (`apps/web/src/lib/commissions.ts`) y adaptado al
 * restaurante: el «vendedor» es el MESERO que atendió la cuenta y el
 * documento es la cuenta (`Order`). Sin React ni Prisma: la aritmética de
 * una liquidación de comisiones se prueba sin levantar nada.
 *
 * Reglas (las mismas de zenith, en clave restaurante):
 *
 *  · BASE = LO COBRADO, por FECHA DE PAGO. Una cuenta abierta no comisiona;
 *    el corte del período es `Order.paidAt`. La base es el subtotal de la
 *    cuenta (sin propina ni impuesto sobre líneas libres) NETO del descuento
 *    del comensal: es lo que el restaurante cobró por la comida.
 *  · El % se SELLA en la cuenta al cobrarla (`Order.commissionBps`). Si el
 *    operador cambia el % del mesero a mitad de mes, las cuentas ya cobradas
 *    conservan el viejo; el resumen sólo muestra un % cuando TODAS las
 *    cuentas de la persona llevan el mismo, si no dice «varios» (y el
 *    detalle cuenta a cuenta lo aclara).
 *  · Puntos base (bps): 250 = 2,50 %. Enteros, para no arrastrar flotantes.
 *  · Sin liquidación contable: la pantalla calcula; no genera asientos.
 *
 * Distinto de `commissions.ts`, que es la comisión del COMERCIAL (rol
 * comercial) sobre las membresías que trae a MESAPAY.
 */

import type { CsvValue } from "@/lib/erp/reports/csv";

/** Tope: 10 000 bps = 100 %. */
export const MAX_COMMISSION_BPS = 10_000;

/** ¿Es una tasa válida? Entero entre 0 y 10 000 bps (0 % a 100 %). */
export function isValidCommissionBps(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_COMMISSION_BPS;
}

/** Porcentaje con hasta 2 decimales (2,5) → bps (250). */
export function pctToBps(pct: number): number {
  return Math.round(pct * 100);
}

/** bps (250) → porcentaje (2.5), para prellenar el campo de configuración. */
export function bpsToPct(bps: number): number {
  return bps / 100;
}

/** bps → «2,50» (coma decimal, para el CSV del contador). */
export function bpsToPctText(bps: number): string {
  return (bps / 100).toFixed(2).replace(".", ",");
}

export type SealedCommission = {
  bps: number;
  /** Subtotal cobrado neto de descuento: la base sobre la que se liquida. */
  baseCents: number;
  /** `round(base × bps / 10 000)`, al centavo. */
  commissionCents: number;
};

/**
 * Lo que queda sellado en la cuenta al cobrarla. `null` cuando el mesero no
 * tiene % (la cuenta no comisiona) o la tasa es inválida: el sellado nunca
 * inventa una comisión.
 */
export function sealCommission({
  waiterBps,
  subtotalCents,
  discountCents = 0,
}: {
  waiterBps: number | null | undefined;
  subtotalCents: number;
  discountCents?: number | null;
}): SealedCommission | null {
  if (!isValidCommissionBps(waiterBps)) return null;
  const subtotal = Number.isFinite(subtotalCents) ? subtotalCents : 0;
  const discount = Number.isFinite(discountCents ?? 0) ? (discountCents ?? 0) : 0;
  const baseCents = Math.max(0, Math.round(subtotal - discount));
  return {
    bps: waiterBps,
    baseCents,
    commissionCents: Math.round((baseCents * waiterBps) / MAX_COMMISSION_BPS),
  };
}

/** Una cuenta cobrada con comisión sellada (fila del detalle). */
export type CommissionRow = {
  orderId: string;
  /** Código corto de la cuenta (lo que ve el comensal / la tirilla). */
  shortCode: string;
  /** Instante del pago (ISO). El período se corta por esta fecha. */
  paidAt: string;
  orderType: string;
  tableNumber: number | null;
  tableLabel: string | null;
  waiterId: string;
  waiterName: string;
  bps: number;
  baseCents: number;
  commissionCents: number;
};

/** Una línea del resumen: la persona. */
export type CommissionPersonRow = {
  waiterId: string;
  waiterName: string;
  /** Cuentas cobradas con comisión en el período. */
  orders: number;
  /** Σ base cobrada. */
  baseCents: number;
  /** % sellado si es el mismo en todas sus cuentas; null = «varios». */
  bps: number | null;
  commissionCents: number;
};

export type CommissionTotals = {
  orders: number;
  /** Cobrado del período (Σ base). */
  baseCents: number;
  /** Comisión a pagar. */
  commissionCents: number;
  /** Personas distintas con algo que cobrar. */
  people: number;
};

export type CommissionReport = {
  summary: CommissionPersonRow[];
  /** Cuenta a cuenta, de la más vieja a la más nueva por fecha de pago. */
  detail: CommissionRow[];
  totals: CommissionTotals;
};

/**
 * Resumen por persona (de mayor a menor comisión), detalle ordenado por
 * fecha de pago y totales del período.
 */
export function buildCommissionReport(rows: readonly CommissionRow[]): CommissionReport {
  const acc = new Map<string, CommissionPersonRow & { rates: Set<number> }>();
  for (const r of rows) {
    let g = acc.get(r.waiterId);
    if (!g) {
      g = {
        waiterId: r.waiterId,
        waiterName: r.waiterName,
        orders: 0,
        baseCents: 0,
        bps: null,
        commissionCents: 0,
        rates: new Set<number>(),
      };
      acc.set(r.waiterId, g);
    }
    g.orders += 1;
    g.baseCents += r.baseCents;
    g.commissionCents += r.commissionCents;
    g.rates.add(r.bps);
  }
  const summary: CommissionPersonRow[] = [...acc.values()]
    .map(({ rates, ...g }) => ({ ...g, bps: rates.size === 1 ? [...rates][0] : null }))
    .sort(
      (a, b) =>
        b.commissionCents - a.commissionCents ||
        a.waiterName.localeCompare(b.waiterName) ||
        a.waiterId.localeCompare(b.waiterId),
    );
  const detail = [...rows].sort(
    (a, b) => a.paidAt.localeCompare(b.paidAt) || a.shortCode.localeCompare(b.shortCode),
  );
  const totals: CommissionTotals = {
    orders: rows.length,
    baseCents: summary.reduce((s, p) => s + p.baseCents, 0),
    commissionCents: summary.reduce((s, p) => s + p.commissionCents, 0),
    people: summary.length,
  };
  return { summary, detail, totals };
}

/** Textos con los que se nombra la cuenta (dependen del idioma). */
export type AccountLabels = {
  /** «Mesa {n}». */
  table: (n: number) => string;
  /** Pedido para recoger. */
  pickup: string;
  /** Factura manual (cuenta sin mesa física). */
  manual: string;
};

/**
 * Cómo se llama la cuenta en pantalla y en el CSV: la etiqueta de la mesa
 * si la tiene, «Mesa N» si es una mesa real, y los dos casos sin mesa
 * física (recogida y factura manual, que llevan número negativo).
 */
export function accountLabel(
  row: Pick<CommissionRow, "orderType" | "tableNumber" | "tableLabel">,
  labels: AccountLabels,
): string {
  if (row.orderType === "pickup") return labels.pickup;
  if (row.tableNumber != null && row.tableNumber < 0) return labels.manual;
  if (row.tableLabel?.trim()) return row.tableLabel.trim();
  return row.tableNumber == null ? labels.manual : labels.table(row.tableNumber);
}

/** Textos que el CSV necesita y que dependen del idioma. */
export type CommissionCsvLabels = {
  /** Etiqueta de la fila de totales («TOTAL»). */
  total: string;
  /** Cuando el % no fue uniforme en el período («varios»). */
  various: string;
};

/**
 * CSV RESUMEN: una fila por persona más la de totales. Los números son
 * centavos (el dialecto de `csv.ts` los saca con dos decimales); lo que
 * no es plata (conteos, %) viaja como texto.
 */
export function commissionCsvSummary(
  report: CommissionReport,
  labels: CommissionCsvLabels,
): CsvValue[][] {
  const rows: CsvValue[][] = report.summary.map((p) => [
    p.waiterName,
    String(p.orders),
    p.baseCents,
    p.bps === null ? labels.various : bpsToPctText(p.bps),
    p.commissionCents,
  ]);
  rows.push([
    labels.total,
    String(report.totals.orders),
    report.totals.baseCents,
    "",
    report.totals.commissionCents,
  ]);
  return rows;
}

/** CSV DETALLE: la cuenta a cuenta que sustenta cada peso del resumen. */
export function commissionCsvDetail(
  detail: readonly CommissionRow[],
  fmt: {
    /** Fecha del pago como texto (el convenio de fecha lo decide el reporte). */
    date: (paidAtIso: string) => string;
    /** «Mesa 5» / «Recogida» / «Factura manual»… */
    account: (row: CommissionRow) => string;
  },
): CsvValue[][] {
  return detail.map((r) => [
    fmt.date(r.paidAt),
    r.shortCode,
    fmt.account(r),
    r.waiterName,
    r.baseCents,
    bpsToPctText(r.bps),
    r.commissionCents,
  ]);
}
