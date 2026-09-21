/**
 * Cartera (cuentas por cobrar y por pagar) — LÓGICA PURA, sin DB ni React.
 *
 * Portado de zenith `reportes/cartera` (lista por tercero + extracto) y
 * `packages/domain/src/payments.ts` (`agingBucket`). Los datos crudos los
 * arma `carteraQueries.ts`; acá sólo se agrupa, se envejece y se ordena.
 *
 * ── Qué es un «documento» de cartera en MESAPAY ─────────────────────────
 * Por PAGAR: órdenes de compra recibidas (total bruto de lo recibido) y
 * gastos manuales no recurrentes; los abonos son `PurchasePayment` y
 * `ExpensePayment`. Por COBRAR: cortes de bonos a crédito
 * (`VoucherStatement`), el único crédito real del comercio — MESAPAY cobra
 * las ventas al momento, así que NO hay facturas de venta a plazo. El tipo
 * `CarteraDoc` es genérico a propósito: si mañana aparece otra fuente
 * (ventas a crédito, anticipos), entra como un `source` más sin tocar los
 * cálculos.
 *
 * FUERA DE ALCANCE (a diferencia de zenith): anticipos / saldos a favor,
 * reaplicación FIFO de pagos, notas crédito, retenciones y moneda
 * extranjera. Aquí un abono siempre pertenece a UN documento.
 *
 * ── Fechas ──────────────────────────────────────────────────────────────
 * Todas las fechas son `yyyy-mm-dd`. La antigüedad se mide en días
 * calendario enteros (`floor((hoy − fecha) / 86 400 000)`), igual que en
 * zenith. `today` viaja como parámetro para que los cálculos sean
 * reproducibles a una fecha de corte (`?hasta=`).
 */
import type { CsvValue } from "./csv";

/** Tramo de antigüedad por VENCIMIENTO (lista por tercero). */
export type AgingBucket = "corriente" | "1-30" | "31-60" | "60+";

export const AGING_BUCKETS: readonly AgingBucket[] = ["corriente", "1-30", "31-60", "60+"];

const BUCKET_ORDER: Record<AgingBucket, number> = {
  corriente: 0,
  "1-30": 1,
  "31-60": 2,
  "60+": 3,
};

/** Clave i18n (`opCartera`) de cada tramo, compartida por API (CSV) y UI. */
export const BUCKET_I18N_KEY = {
  corriente: "bucketCurrent",
  "1-30": "bucket1_30",
  "31-60": "bucket31_60",
  "60+": "bucket60",
} as const satisfies Record<AgingBucket, string>;

export type CarteraKind = "cxc" | "cxp";

/** Origen del documento (decide el enlace y la etiqueta en la UI). */
export type CarteraDocSource = "purchase_order" | "expense" | "voucher_statement";

/**
 * Tercero sintético para los gastos sin proveedor: se agrupan bajo este
 * id para que su saldo no quede invisible en la cartera. La UI lo etiqueta
 * con `opCartera.noSupplier`.
 */
export const NO_SUPPLIER_ID = "sin-proveedor";

/** Un documento con saldo (o con historia, en el extracto). */
export type CarteraDoc = {
  id: string;
  source: CarteraDocSource;
  partnerId: string;
  partnerName: string;
  partnerTaxId: string | null;
  /** Número visible: factura del proveedor, consecutivo de la OC, concepto del gasto, período del corte. */
  number: string;
  /** Fecha del documento. */
  date: string;
  /** Vencimiento efectivo (pactado, o fecha + plazo del proveedor). */
  dueDate: string;
  totalCents: number;
  /** Saldo a la fecha de corte: total − abonos pagados hasta esa fecha. */
  outstandingCents: number;
};

/** Abono a un documento (pago a proveedor, pago de gasto, pago del corte). */
export type CarteraPayment = {
  id: string;
  docId: string;
  date: string;
  amountCents: number;
  note: string | null;
};

const DAY_MS = 86_400_000;

function parseDay(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

/** Días calendario enteros de `from` a `today` (negativo si `from` es futuro). */
export function daysBetween(from: string, today: string): number {
  return Math.floor((parseDay(today) - parseDay(from)) / DAY_MS);
}

/** `iso` + n días (n puede ser negativo). */
export function addDays(iso: string, days: number): string {
  const d = new Date(parseDay(iso) + days * DAY_MS);
  return d.toISOString().slice(0, 10);
}

/**
 * Tramo por vencimiento (zenith `agingBucket`): días = floor((hoy − vence) /
 * día); ≤ 0 corriente, ≤ 30 «1-30», ≤ 60 «31-60», el resto «60+».
 */
export function agingBucket(dueDate: string, today: string): AgingBucket {
  const days = daysBetween(dueDate, today);
  if (days <= 0) return "corriente";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  return "60+";
}

/** El peor tramo de un conjunto (lista vacía → corriente). */
export function worstBucket(buckets: readonly AgingBucket[]): AgingBucket {
  let worst: AgingBucket = "corriente";
  for (const b of buckets) if (BUCKET_ORDER[b] > BUCKET_ORDER[worst]) worst = b;
  return worst;
}

// ─── Lista por tercero ───────────────────────────────────────────────────

export type PartnerSummary = {
  partnerId: string;
  partnerName: string;
  partnerTaxId: string | null;
  /** Documentos con saldo. */
  docs: number;
  /** Vencimiento más antiguo entre los documentos con saldo. */
  oldestDue: string;
  worstBucket: AgingBucket;
  outstandingCents: number;
};

export type CarteraTotals = {
  outstandingCents: number;
  partners: number;
  docs: number;
};

export type CarteraSide = {
  partners: PartnerSummary[];
  totals: CarteraTotals;
};

/**
 * Una fila por tercero con su saldo, cuántos documentos lo componen, el
 * vencimiento más viejo y el peor tramo. Sólo entran documentos con saldo
 * positivo; orden por saldo descendente (desempate por nombre).
 */
export function buildPartnerSummary(docs: readonly CarteraDoc[], today: string): CarteraSide {
  const byPartner = new Map<string, PartnerSummary>();
  let totalDocs = 0;
  for (const d of docs) {
    if (d.outstandingCents <= 0) continue;
    totalDocs += 1;
    const bucket = agingBucket(d.dueDate, today);
    const g = byPartner.get(d.partnerId);
    if (!g) {
      byPartner.set(d.partnerId, {
        partnerId: d.partnerId,
        partnerName: d.partnerName,
        partnerTaxId: d.partnerTaxId,
        docs: 1,
        oldestDue: d.dueDate,
        worstBucket: bucket,
        outstandingCents: d.outstandingCents,
      });
      continue;
    }
    g.docs += 1;
    g.outstandingCents += d.outstandingCents;
    if (d.dueDate < g.oldestDue) g.oldestDue = d.dueDate;
    g.worstBucket = worstBucket([g.worstBucket, bucket]);
  }
  const partners = [...byPartner.values()].sort(
    (a, b) => b.outstandingCents - a.outstandingCents || a.partnerName.localeCompare(b.partnerName),
  );
  return {
    partners,
    totals: {
      outstandingCents: partners.reduce((s, p) => s + p.outstandingCents, 0),
      partners: partners.length,
      docs: totalDocs,
    },
  };
}

/**
 * Filas del CSV de la lista: Tercero, NIT, Documentos, Vence más antiguo,
 * Antigüedad, Saldo. `partnerLabel` resuelve el nombre visible (el tercero
 * sintético «sin proveedor» se traduce en la capa de presentación) y
 * `bucketLabel` la etiqueta del tramo. El saldo va como número → la
 * capa CSV lo escribe como monto con coma decimal.
 */
export function carteraCsvRows(
  partners: readonly PartnerSummary[],
  labels: {
    partnerLabel: (p: PartnerSummary) => string;
    bucketLabel: (b: AgingBucket) => string;
  },
): CsvValue[][] {
  return partners.map((p) => [
    labels.partnerLabel(p),
    p.partnerTaxId ?? "",
    String(p.docs),
    p.oldestDue,
    labels.bucketLabel(p.worstBucket),
    p.outstandingCents,
  ]);
}

// ─── Extracto por tercero ────────────────────────────────────────────────

export type StatementEntry = {
  key: string;
  date: string;
  kind: "cargo" | "abono";
  /** Documento al que pertenece (el cargo mismo, o el documento abonado). */
  docId: string;
  source: CarteraDocSource;
  number: string;
  /** Vencimiento del documento (sólo en cargos). */
  dueDate: string | null;
  note: string | null;
  cargoCents: number;
  abonoCents: number;
  /** Saldo corrido, siempre cronológico. */
  balanceCents: number;
};

/** Tabla de edades por ANTIGÜEDAD DEL DOCUMENTO (días desde su fecha). */
export type StatementAging = {
  d0a30Cents: number;
  d31a60Cents: number;
  d61a90Cents: number;
  mas90Cents: number;
  /** Suma de los saldos pendientes. */
  pendingCents: number;
  /** Saldo de los documentos cuyo vencimiento REAL ya pasó. */
  overdueCents: number;
};

export type Statement = {
  entries: StatementEntry[];
  aging: StatementAging;
  totals: { cargosCents: number; abonosCents: number; balanceCents: number };
};

const KIND_ORDER = { cargo: 0, abono: 1 } as const;

const collator = new Intl.Collator("es", { numeric: true, sensitivity: "base" });

/**
 * Estado de cuenta: un cargo por documento y un abono por pago, en orden
 * cronológico (fecha → cargo antes que abono → número → id), con saldo
 * corrido. Los abonos cuyo documento no está en `docs` se ignoran (no
 * pueden fecharse ni etiquetarse); los documentos entran aunque estén
 * saldados, porque su cargo y sus abonos son la historia del tercero.
 *
 * Edades: cada tramo suma el saldo pendiente de los documentos fechados en
 * ese rango (antigüedad = días desde la FECHA del documento, no desde el
 * vencimiento). «Total vencido» sí usa el vencimiento real.
 */
export function buildStatement(
  docs: readonly CarteraDoc[],
  payments: readonly CarteraPayment[],
  today: string,
): Statement {
  const docById = new Map(docs.map((d) => [d.id, d]));
  const raw: Omit<StatementEntry, "balanceCents">[] = [];
  for (const d of docs) {
    raw.push({
      key: `doc:${d.id}`,
      date: d.date,
      kind: "cargo",
      docId: d.id,
      source: d.source,
      number: d.number,
      dueDate: d.dueDate,
      note: null,
      cargoCents: d.totalCents,
      abonoCents: 0,
    });
  }
  for (const p of payments) {
    const d = docById.get(p.docId);
    if (!d) continue;
    raw.push({
      key: `pay:${p.id}`,
      date: p.date,
      kind: "abono",
      docId: d.id,
      source: d.source,
      number: d.number,
      dueDate: null,
      note: p.note,
      cargoCents: 0,
      abonoCents: p.amountCents,
    });
  }
  raw.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      collator.compare(a.number, b.number) ||
      a.key.localeCompare(b.key),
  );

  let running = 0;
  let cargosCents = 0;
  let abonosCents = 0;
  const entries: StatementEntry[] = raw.map((e) => {
    running += e.cargoCents - e.abonoCents;
    cargosCents += e.cargoCents;
    abonosCents += e.abonoCents;
    return { ...e, balanceCents: running };
  });

  const aging: StatementAging = {
    d0a30Cents: 0,
    d31a60Cents: 0,
    d61a90Cents: 0,
    mas90Cents: 0,
    pendingCents: 0,
    overdueCents: 0,
  };
  for (const d of docs) {
    if (d.outstandingCents <= 0) continue;
    aging.pendingCents += d.outstandingCents;
    const age = daysBetween(d.date, today);
    if (age <= 30) aging.d0a30Cents += d.outstandingCents;
    else if (age <= 60) aging.d31a60Cents += d.outstandingCents;
    else if (age <= 90) aging.d61a90Cents += d.outstandingCents;
    else aging.mas90Cents += d.outstandingCents;
    if (daysBetween(d.dueDate, today) > 0) aging.overdueCents += d.outstandingCents;
  }

  return {
    entries,
    aging,
    totals: { cargosCents, abonosCents, balanceCents: running },
  };
}
