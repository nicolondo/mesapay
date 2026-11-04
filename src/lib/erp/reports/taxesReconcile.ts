/**
 * IMPUESTOS DEL PERÍODO — ¿por qué el libro no dice lo mismo que los
 * documentos? (lógica pura). Descompone, impuesto por impuesto, la
 * diferencia `libro − documentos` del nivel 1 en componentes EXACTOS, cada
 * uno con las filas que lo forman:
 *
 *   · sinFactura      pedidos cobrados sin factura: el motor les causa el
 *                     impuesto con la tarifa del comercio (`orderSalesTaxSlice`)
 *                     y ninguna factura lo declara;
 *   · corte           documentos que el motor asienta en el DÍA DE NEGOCIO
 *                     (Bogotá + hora de corte) y que por eso caen en otro
 *                     período que el de su fecha (el documental corta en UTC);
 *   · cuentaAnulada   facturas de cuentas que ya no están pagadas: el motor
 *                     sólo causa impuesto de pedidos pagados;
 *   · sinAsiento      documentos de días que todavía no tienen asiento de su
 *                     fuente (el motor corre cada madrugada o al tocar
 *                     «Generar asientos»);
 *   · desactualizado  días con asiento cuyo impuesto no coincide con lo que
 *                     dicen hoy sus documentos (cambiaron después de asentar);
 *   · sinDocumento    líneas del libro de fuentes sin documento: comprobantes
 *                     manuales, pagos de declaraciones, reversas…
 *
 * Identidad (test): para cada impuesto, Σ componentes = libro − documentos.
 * Se obtiene así:
 *
 *   libro − doc = Σ_origen (libro_o − esperado_o)      → sinAsiento + desactualizado
 *               + Σ_origen (esperado_o − doc_o)        → sinFactura + corte + cuentaAnulada
 *               + libro sin origen                     → sinDocumento
 *
 * donde `esperado_o` es lo que el motor asentaría hoy para el origen en los
 * días de negocio del período. Las notas crédito y los gastos se asientan
 * por su fecha (fiscal / contable), así que su esperado es el documental; las
 * devoluciones sin nota no tienen documento por día y se cruzan en bloque.
 */
import { bogotaBusinessDateIso } from "@/lib/bogota";
import type { SalesTaxKind } from "../accounting";
import {
  DRILL_TAXES,
  ORIGIN_SOURCE,
  originOfSource,
  type DocFact,
  type DrillOrigin,
  type DrillTaxKey,
  type LedgerFact,
} from "./taxesDrill";

/** Un pedido pagado tal como lo asienta el motor («Ventas del día»). */
export type EngineOrder = {
  orderId: string;
  shortCode: string | null;
  paidAtIso: string;
  status: string;
  /** null = el pedido no tiene factura. */
  invoiceId: string | null;
  /** Tramo que el motor le causa (`orderSalesTaxSlice`). */
  slice: { kind: SalesTaxKind; pct: number; baseCents: number; taxCents: number };
  /** Tramos de sus líneas libres (`orderFreeLineTaxSlices`): impuesto ENCIMA. */
  freeSlices?: readonly { kind: SalesTaxKind; pct: number; baseCents: number; taxCents: number }[];
};

/** Asiento del motor de una fuente en un día. */
export type EngineEntry = { id: string; source: string; day: string; /** `#000123` si ya está numerado. */ voucher?: string | null };

export type ReconComponent =
  | "sinFactura"
  | "corte"
  | "cuentaAnulada"
  | "sinAsiento"
  | "desactualizado"
  | "sinDocumento";

export const RECON_COMPONENTS: readonly ReconComponent[] = [
  "sinFactura",
  "corte",
  "cuentaAnulada",
  "sinAsiento",
  "desactualizado",
  "sinDocumento",
];

/** Documento que explica una diferencia, con su aporte a `libro − documentos`. */
export type ReconDocRow = DocFact & {
  /** Día de negocio en que lo asienta el motor (null = sin día propio). */
  day: string | null;
  /** Aporte de la fila a `libro − documentos`. */
  deltaCents: number;
};

/** Día cuyo asiento no coincide con sus documentos. */
export type ReconDayRow = {
  key: string;
  tax: DrillTaxKey;
  origin: DrillOrigin;
  source: string;
  /** null = las devoluciones sin nota, que se cruzan por período. */
  day: string | null;
  expectedCents: number;
  bookCents: number;
  /** libro − esperado. */
  deltaCents: number;
  entryId: string | null;
  docCount: number;
};

export type TaxReconciliation = {
  tax: DrillTaxKey;
  diffCents: number;
  components: Record<ReconComponent, number>;
};

export type Reconciliation = {
  byTax: TaxReconciliation[];
  rows: {
    sinFactura: ReconDocRow[];
    corte: ReconDocRow[];
    cuentaAnulada: ReconDocRow[];
    sinAsiento: ReconDocRow[];
    desactualizado: ReconDayRow[];
    sinDocumento: LedgerFact[];
  };
};

export type ReconInput = {
  period: { desde: string; hasta: string };
  cutoffHour: number;
  /** Hechos documentales del período (los del nivel 2/3). */
  docs: readonly DocFact[];
  /**
   * Hechos de COMPRAS/GASTOS con fecha en la ventana extendida (el período
   * más el día de negocio que lo desborda): de ahí salen los que el motor
   * asienta en el período aunque su fecha UTC caiga después.
   */
  windowPurchaseFacts: readonly DocFact[];
  /** Hechos de VENTAS facturadas de la ventana extendida (mismas claves que `docs`). */
  windowSaleFacts: readonly DocFact[];
  /** Pedidos pagados de la ventana extendida, con y sin factura. */
  orders: readonly EngineOrder[];
  /** Hechos del libro del período. */
  ledger: readonly LedgerFact[];
  /** Asientos del motor del período (fuente + día). */
  entries: readonly EngineEntry[];
};

const inPeriod = (day: string, p: { desde: string; hasta: string }) => day >= p.desde && day <= p.hasta;

/** Día en que el motor asienta un documento de un origen. */
export function engineDay(origin: DrillOrigin, dateIso: string, cutoffHour: number): string | null {
  switch (origin) {
    case "ventas":
    case "compras":
      return bogotaBusinessDateIso(new Date(dateIso), cutoffHour);
    case "notas":
    case "gastos":
      // Fecha fiscal / contable: ya viene como día (mediodía o medianoche UTC).
      return dateIso.slice(0, 10);
    case "devoluciones":
      return null;
  }
}

const zero = (): Record<ReconComponent, number> => ({
  sinFactura: 0,
  corte: 0,
  cuentaAnulada: 0,
  sinAsiento: 0,
  desactualizado: 0,
  sinDocumento: 0,
});

/** Hechos de un pedido sin factura: lo embebido de la carta y lo que suman sus líneas libres. */
export function orderFacts(o: EngineOrder): DocFact[] {
  const out: DocFact[] = [];
  const main = orderFact(o);
  if (main) out.push(main);
  for (const f of o.freeSlices ?? []) {
    const fact = orderFact({ ...o, slice: f }, `ord:${o.orderId}:libre:${f.kind}:${f.pct}`);
    if (fact) out.push(fact);
  }
  return out;
}

/** Hecho de un pedido sin factura (el impuesto que el motor le causa). */
export function orderFact(o: EngineOrder, key = `ord:${o.orderId}`): DocFact | null {
  const { kind, pct, baseCents, taxCents } = o.slice;
  if (kind === "none") return null;
  if (taxCents === 0 && baseCents === 0) return null;
  return {
    key,
    tax: kind,
    origin: "ventas",
    rateKey: String(pct),
    pct,
    conceptName: null,
    docKind: "order",
    docId: o.orderId,
    document: o.shortCode,
    reference: null,
    dateIso: o.paidAtIso,
    party: null,
    nit: null,
    baseCents,
    taxCents,
    grossTaxCents: null,
    nonDeductibleCents: null,
  };
}

export function reconcileTaxes(input: ReconInput): Reconciliation {
  const { period, cutoffHour } = input;
  const dayOf = (f: DocFact) => engineDay(f.origin, f.dateIso, cutoffHour);
  const withDelta = (f: DocFact, deltaCents: number): ReconDocRow => ({ ...f, day: dayOf(f), deltaCents });

  // ── esperado del motor, por origen ───────────────────────────────────
  const orderByInvoice = new Map<string, EngineOrder>();
  for (const o of input.orders) if (o.invoiceId) orderByInvoice.set(o.invoiceId, o);
  const paidInPeriod = (o: EngineOrder) =>
    o.status === "paid" && inPeriod(bogotaBusinessDateIso(new Date(o.paidAtIso), cutoffHour), period);

  // Ventas facturadas que el motor asienta en el período: pedido pagado y
  // día de negocio dentro. Las mismas claves que el documental.
  const expectedSales = input.windowSaleFacts.filter((f) => {
    const o = f.docId ? orderByInvoice.get(f.docId) : undefined;
    return o ? paidInPeriod(o) : false;
  });
  const noInvoiceFacts = input.orders.filter((o) => !o.invoiceId && paidInPeriod(o)).flatMap(orderFacts);
  const expectedPurchases = input.windowPurchaseFacts.filter((f) => {
    const day = dayOf(f);
    return day != null && inPeriod(day, period);
  });
  const docsOf = (o: DrillOrigin) => input.docs.filter((f) => f.origin === o);
  const expected: DocFact[] = [
    ...expectedSales,
    ...noInvoiceFacts,
    ...expectedPurchases,
    ...docsOf("notas"),
    ...docsOf("devoluciones"),
    ...docsOf("gastos"),
  ];

  // ── esperado − documental: sin factura, corte y cuentas anuladas ──────
  const sinFactura = noInvoiceFacts.map((f) => withDelta(f, f.taxCents));
  const corte: ReconDocRow[] = [];
  const cuentaAnulada: ReconDocRow[] = [];
  for (const origin of ["ventas", "compras"] as const) {
    const exp = new Map<string, DocFact>();
    for (const f of origin === "ventas" ? expectedSales : expectedPurchases) exp.set(f.key, f);
    const doc = new Map<string, DocFact>();
    for (const f of docsOf(origin)) doc.set(f.key, f);
    for (const [key, f] of doc) {
      const e = exp.get(key);
      const delta = (e?.taxCents ?? 0) - f.taxCents;
      if (delta === 0) continue;
      const o = origin === "ventas" && f.docId ? orderByInvoice.get(f.docId) : undefined;
      if (!e && o && o.status !== "paid") cuentaAnulada.push(withDelta(f, delta));
      else corte.push(withDelta(e ?? f, delta));
    }
    for (const [key, e] of exp) {
      if (doc.has(key) || e.taxCents === 0) continue;
      corte.push(withDelta(e, e.taxCents));
    }
  }

  // ── libro − esperado, por origen y día ───────────────────────────────
  const entryOf = new Map<string, string>();
  for (const e of input.entries) entryOf.set(`${e.source}|${e.day}`, e.id);
  const sinAsiento: ReconDocRow[] = [];
  const desactualizado: ReconDayRow[] = [];
  for (const tax of DRILL_TAXES) {
    for (const origin of Object.keys(ORIGIN_SOURCE) as DrillOrigin[]) {
      const source = ORIGIN_SOURCE[origin];
      const expByDay = new Map<string, DocFact[]>();
      for (const f of expected) {
        if (f.tax !== tax || f.origin !== origin) continue;
        const day = dayOf(f) ?? "*";
        const list = expByDay.get(day) ?? [];
        list.push(f);
        expByDay.set(day, list);
      }
      const bookByDay = new Map<string, number>();
      for (const l of input.ledger) {
        if (l.tax !== tax || l.source !== source) continue;
        const day = origin === "devoluciones" ? "*" : l.dateIso.slice(0, 10);
        bookByDay.set(day, (bookByDay.get(day) ?? 0) + l.valueCents);
      }
      const days = new Set([...expByDay.keys(), ...bookByDay.keys()]);
      for (const day of [...days].sort()) {
        const facts = expByDay.get(day) ?? [];
        const exp = facts.reduce((s, f) => s + f.taxCents, 0);
        const book = bookByDay.get(day) ?? 0;
        if (book === exp) continue;
        const entryId = day === "*" ? null : (entryOf.get(`${source}|${day}`) ?? null);
        if (day !== "*" && entryId === null && book === 0) {
          for (const f of facts) if (f.taxCents !== 0) sinAsiento.push(withDelta(f, -f.taxCents));
          continue;
        }
        desactualizado.push({
          key: `${tax}|${source}|${day}`,
          tax,
          origin,
          source,
          day: day === "*" ? null : day,
          expectedCents: exp,
          bookCents: book,
          deltaCents: book - exp,
          entryId,
          docCount: facts.length,
        });
      }
    }
  }

  const sinDocumento = input.ledger.filter((l) => l.tax !== null && originOfSource(l.source) === null);

  // ── por impuesto ─────────────────────────────────────────────────────
  const byTax: TaxReconciliation[] = DRILL_TAXES.map((tax) => {
    const c = zero();
    const add = (k: ReconComponent, rows: readonly { tax: DrillTaxKey | null; deltaCents?: number; valueCents?: number }[]) => {
      for (const r of rows) if (r.tax === tax) c[k] += r.deltaCents ?? r.valueCents ?? 0;
    };
    add("sinFactura", sinFactura);
    add("corte", corte);
    add("cuentaAnulada", cuentaAnulada);
    add("sinAsiento", sinAsiento);
    add("desactualizado", desactualizado);
    add("sinDocumento", sinDocumento);
    const doc = input.docs.filter((f) => f.tax === tax).reduce((s, f) => s + f.taxCents, 0);
    const book = input.ledger.filter((l) => l.tax === tax).reduce((s, l) => s + l.valueCents, 0);
    return { tax, diffCents: book - doc, components: c };
  });

  const byDateKey = <T extends { dateIso: string; key: string }>(a: T, b: T) =>
    a.dateIso.localeCompare(b.dateIso) || a.key.localeCompare(b.key);
  return {
    byTax,
    rows: {
      sinFactura: sinFactura.sort(byDateKey),
      corte: corte.sort(byDateKey),
      cuentaAnulada: cuentaAnulada.sort(byDateKey),
      sinAsiento: sinAsiento.sort(byDateKey),
      desactualizado: desactualizado.sort(
        (a, b) => (a.day ?? "").localeCompare(b.day ?? "") || a.key.localeCompare(b.key),
      ),
      sinDocumento: [...sinDocumento].sort(byDateKey),
    },
  };
}

/** Σ componentes de un impuesto (debe ser su `diffCents`). */
export function componentsTotal(r: TaxReconciliation): number {
  return Object.values(r.components).reduce((s, v) => s + v, 0);
}
