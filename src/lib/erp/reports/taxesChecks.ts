/**
 * IMPUESTOS DEL PERÍODO — «Revisar antes de declarar» (lógica pura). Cada
 * revisión mira UNA cosa que se puede calcular con certeza a partir de los
 * datos que ya guarda MESAPAY y devuelve cuántos hallazgos hay, la plata
 * involucrada y las filas exactas (auxiliares) que lo forman, para que la
 * pantalla diga en lenguaje claro qué significa y qué hacer.
 *
 * Una revisión con `count: 0` PASÓ (la pantalla la lista como «sin
 * hallazgos»: también es información). Los textos viven en el catálogo
 * (`opImpuestosRep.check_<key>_*`); acá sólo hay claves y parámetros.
 *
 * Fuera de alcance por ahora (no se pueden calcular con certeza con el
 * modelo actual) — ver el PR: el concepto de retención EXACTO de cada
 * compra (la cabecera sólo guarda el valor), proveedores autorretenedores o
 * grandes contribuyentes (no hay campo), el histórico de la tarifa del
 * comercio y las facturas POS sin documento electrónico.
 */
import { isValidNitDv } from "../exogena";
import {
  docAuxRow,
  ledgerAuxRow,
  dayAuxRow,
  type AuxFlag,
  type AuxRow,
} from "./auxRows";
import type { CurrentSalesTax, ExpenseTaxInput, PurchaseTaxInput, SaleTaxInput } from "./taxesDocuments";
import { pickRetefuenteConcept } from "../expenseTax";
import { pickPurchaseRetefuenteConcept } from "../purchaseRetentions";
import { purchaseLineTaxCents } from "./taxesDocuments";
import { ORIGIN_SOURCE, type DocFact, type DrillOrigin, type DrillTaxKey } from "./taxesDrill";
import { engineDay, type EngineEntry, type Reconciliation } from "./taxesReconcile";

export type CheckSeverity = "critical" | "warning" | "info";

export type CheckKey =
  | "dianRechazada"
  | "sinAsiento"
  | "desactualizado"
  | "sinFactura"
  | "cuentaAnulada"
  | "dianPendiente"
  | "tarifaDistinta"
  | "sinImpuesto"
  | "descuentoSinDeclarar"
  | "retencionOmitida"
  | "retencionBajoUmbral"
  | "ivaNoDescontable"
  | "terceroSinNit"
  | "corte"
  | "sinDocumento"
  | "notasCredito"
  | "facturadaPendiente"
  | "variacion";

/** Orden de lectura dentro de una misma severidad. */
export const CHECK_ORDER: readonly CheckKey[] = [
  "dianRechazada",
  "sinAsiento",
  "desactualizado",
  "sinFactura",
  "cuentaAnulada",
  "dianPendiente",
  "tarifaDistinta",
  "sinImpuesto",
  "descuentoSinDeclarar",
  "retencionOmitida",
  "retencionBajoUmbral",
  "ivaNoDescontable",
  "terceroSinNit",
  "corte",
  "sinDocumento",
  "notasCredito",
  "facturadaPendiente",
  "variacion",
];

const SEVERITY: Record<CheckKey, CheckSeverity> = {
  dianRechazada: "critical",
  sinAsiento: "warning",
  desactualizado: "warning",
  sinFactura: "warning",
  cuentaAnulada: "warning",
  dianPendiente: "warning",
  tarifaDistinta: "warning",
  sinImpuesto: "warning",
  descuentoSinDeclarar: "warning",
  retencionOmitida: "warning",
  retencionBajoUmbral: "warning",
  ivaNoDescontable: "warning",
  terceroSinNit: "warning",
  corte: "info",
  sinDocumento: "info",
  notasCredito: "info",
  facturadaPendiente: "info",
  variacion: "info",
};

export type SpikeDetail = {
  tax: DrillTaxKey;
  currentCents: number;
  averageCents: number;
  /** Variación frente al promedio, en % entero (positivo = subió). */
  changePct: number;
};

export type CheckResult = {
  key: CheckKey;
  severity: CheckSeverity;
  /** Hallazgos. 0 = la revisión pasó. */
  count: number;
  /** Plata involucrada, con signo cuando lo tiene (corte, libro − documentos). */
  amountCents: number;
  /** Impuestos afectados (para abrir su renglón). */
  taxes: DrillTaxKey[];
  /** Parámetros de los textos. */
  params: Record<string, string | number>;
  /** Las filas exactas (auxiliares) del hallazgo. */
  rows: AuxRow[];
  /** Sólo `variacion`: un renglón por impuesto con un salto inusual. */
  spikes?: SpikeDetail[];
};

/** Estado ante la DIAN de un documento electrónico del período. */
export type DianState = { state: string; lastError: string | null };

export type RetentionConceptFull = {
  kind: string;
  name: string;
  /** Tarifa efectiva en bps (puede tener decimales). */
  rateBps: number;
  base: string;
  thresholdUvt: number;
  active: boolean;
  /** Clave del catálogo: elige la retefuente por tema. */
  catalogKey?: string | null;
};

export type ChecksInput = {
  recon: Reconciliation;
  /** Facturas del período (todas, también las sin impuesto). */
  sales: readonly SaleTaxInput[];
  /** Compras del período. */
  purchases: readonly PurchaseTaxInput[];
  /** Gastos del período con IVA, INC o retenciones (origen «gastos»). */
  expenses?: readonly ExpenseTaxInput[];
  /** Hechos documentales del período. */
  docs: readonly DocFact[];
  currentTax: CurrentSalesTax;
  purchaseIvaDeductible: boolean;
  concepts: readonly RetentionConceptFull[];
  uvtCents: number;
  cutoffHour: number;
  entries: readonly EngineEntry[];
  /** Estado DIAN por id de factura (sólo las electrónicas). */
  dianInvoices: ReadonlyMap<string, DianState>;
  /** Notas crédito del período que la DIAN aún no acepta o rechazó. */
  dianCreditNotes: readonly {
    id: string;
    document: string;
    reference: string | null;
    dateIso: string;
    state: string;
    taxCents: number;
    party: string | null;
    nit: string | null;
  }[];
  /** Serie de los últimos períodos por impuesto (el último = el actual). */
  trend?: Partial<Record<DrillTaxKey, readonly number[]>>;
  /**
   * Facturas emitidas ANTES de cobrar en el período cuya cuenta sigue sin
   * cobrarse (`loadPendingPaymentSaleDocs`). No están en los documentos ni
   * en el libro —la venta entra el día que se cobra— y NO son un error:
   * la revisión las muestra como «facturadas, pendientes de pago».
   */
  pendingPaymentSales?: readonly SaleTaxInput[];
};

const REJECTED = new Set(["rejected"]);
const PENDING = new Set(["to_send", "sent", "pending", "error"]);

const sumAmount = (rows: readonly AuxRow[]) => rows.reduce((s, r) => s + r.amountCents, 0);
const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];

function result(
  key: CheckKey,
  rows: AuxRow[],
  opts: { taxes?: DrillTaxKey[]; amountCents?: number; params?: Record<string, string | number>; count?: number } = {},
): CheckResult {
  return {
    key,
    severity: SEVERITY[key],
    count: opts.count ?? rows.length,
    amountCents: opts.amountCents ?? sumAmount(rows),
    taxes: opts.taxes ?? [],
    params: opts.params ?? {},
    rows,
  };
}

/**
 * Problema del NIT de un proveedor con las mismas reglas que la exógena
 * (`exogena/sources.supplierTercero`): vacío ⇒ sin NIT; «900123456-7» ⇒ el
 * DV escrito se valida contra el módulo 11.
 */
export function supplierTaxIdIssue(taxId: string | null | undefined): "noNit" | "invalidDv" | null {
  const raw = (taxId ?? "").trim().replace(/^nit\.?\s*/i, "");
  if (!raw || !/\d/.test(raw)) return "noNit";
  const m = /^(.*\d)\s*-\s*(\d)$/.exec(raw);
  if (m && !isValidNitDv(m[1]!.replace(/\D/g, ""), m[2]!)) return "invalidDv";
  return null;
}

/** Fila de una factura (aunque no tenga hecho: las sin impuesto también se listan). */
function saleRow(s: SaleTaxInput, amountCents: number, flags?: AuxFlag[]): AuxRow {
  return {
    key: `inv:${s.invoiceId}`,
    kind: "doc",
    dateIso: s.dateIso,
    amountCents,
    docKind: "invoice",
    docId: s.invoiceId,
    document: s.document,
    party: s.customer?.name ?? null,
    nit: s.customer?.docNumber ?? null,
    baseCents: s.baseCents,
    pct: s.taxKind === "none" ? null : s.taxPct,
    ...(flags?.length ? { flags } : {}),
  };
}

const salesTaxKey = (s: SaleTaxInput): DrillTaxKey[] => (s.taxKind === "none" ? [] : [s.taxKind]);

/** Subtotal (neto) de una compra: la base de retefuente y reteICA. */
function purchaseSubtotal(p: PurchaseTaxInput): number {
  return p.lines.reduce((s, l) => s + l.netCents, 0);
}

function purchaseIva(p: PurchaseTaxInput): number {
  return p.lines.reduce((s, l) => s + (l.taxCents ?? purchaseLineTaxCents(l.netCents, l.taxPct)), 0);
}

/**
 * Conceptos ACTIVOS de una clase que aplican a una compra, con la misma
 * regla que `retenciones.computeRetentions`: base > 0 y subtotal ≥ umbral
 * (umbral 0 = siempre).
 */
export function applicableConcepts(
  concepts: readonly RetentionConceptFull[],
  kind: string,
  doc: { subtotalCents: number; taxCents: number },
  uvtCents: number,
): { concept: RetentionConceptFull; amountCents: number }[] {
  const out: { concept: RetentionConceptFull; amountCents: number }[] = [];
  for (const c of concepts) {
    if (!c.active || c.kind !== kind) continue;
    const base = c.base === "tax" ? doc.taxCents : doc.subtotalCents;
    if (base <= 0) continue;
    const threshold = c.thresholdUvt * uvtCents;
    if (threshold > 0 && doc.subtotalCents < threshold) continue;
    const amountCents = Math.round((base * c.rateBps) / 10_000);
    if (amountCents > 0) out.push({ concept: c, amountCents });
  }
  return out;
}

const RET_KINDS = ["retefuente", "reteiva", "reteica"] as const;
const retOf = (p: PurchaseTaxInput, kind: (typeof RET_KINDS)[number]) =>
  kind === "retefuente" ? p.retefuenteCents : kind === "reteiva" ? p.reteIvaCents : p.reteIcaCents;

/** Corre todas las revisiones, en `CHECK_ORDER`. */
export function runTaxChecks(input: ChecksInput): CheckResult[] {
  const { recon, currentTax } = input;
  const entryOf = new Map<string, string>();
  for (const e of input.entries) entryOf.set(`${e.source}|${e.day}`, e.id);
  const entryFor = (f: DocFact) => {
    const day = engineDay(f.origin, f.dateIso, input.cutoffHour);
    return day ? (entryOf.get(`${ORIGIN_SOURCE[f.origin]}|${day}`) ?? null) : null;
  };
  const taxesOf = (rows: readonly { tax: DrillTaxKey | null }[]) =>
    uniq(rows.map((r) => r.tax).filter((t): t is DrillTaxKey => t !== null));

  const out: CheckResult[] = [];

  // ── DIAN ─────────────────────────────────────────────────────────────
  const dianRows = (states: Set<string>, flag: AuxFlag) => {
    const rows: AuxRow[] = [];
    const taxes: DrillTaxKey[] = [];
    for (const s of input.sales) {
      const d = input.dianInvoices.get(s.invoiceId);
      if (!d || !states.has(d.state)) continue;
      rows.push({ ...saleRow(s, s.taxCents, [flag]), memo: d.lastError });
      taxes.push(...salesTaxKey(s));
    }
    for (const n of input.dianCreditNotes) {
      if (!states.has(n.state)) continue;
      rows.push({
        key: `nc:${n.id}`,
        kind: "doc",
        dateIso: n.dateIso,
        amountCents: -n.taxCents,
        docKind: "credit_note",
        docId: n.id,
        document: n.document,
        reference: n.reference,
        party: n.party,
        nit: n.nit,
        flags: [flag],
      });
    }
    return { rows, taxes: uniq(taxes) };
  };
  const rejected = dianRows(REJECTED, "dianRejected");
  const pending = dianRows(PENDING, "dianPending");

  // ── Reconciliación ───────────────────────────────────────────────────
  const sinAsiento = recon.rows.sinAsiento.map((f) =>
    docAuxRow(f, { amountCents: f.taxCents, day: f.day, flags: ["noEntry"] }),
  );
  const desactualizado = recon.rows.desactualizado.map(dayAuxRow);
  const sinFactura = recon.rows.sinFactura.map((f) =>
    docAuxRow(f, { amountCents: f.deltaCents, day: f.day, entryId: entryFor(f), flags: ["estimated"] }),
  );
  const cuentaAnulada = recon.rows.cuentaAnulada.map((f) =>
    docAuxRow(f, { amountCents: f.taxCents, day: f.day, flags: ["orderCancelled"] }),
  );
  const corte = recon.rows.corte.map((f) =>
    docAuxRow(f, {
      amountCents: f.deltaCents,
      day: f.day,
      entryId: entryFor(f),
      flags: [f.deltaCents > 0 ? "intoPeriod" : "otherPeriod"],
    }),
  );
  const sinDocumento = recon.rows.sinDocumento.map(ledgerAuxRow);

  // ── Tarifa de las facturas ───────────────────────────────────────────
  const tarifa: AuxRow[] = [];
  const tarifaTaxes: DrillTaxKey[] = [];
  const sinImp: AuxRow[] = [];
  if (currentTax.kind !== "none") {
    for (const s of input.sales) {
      if (s.taxKind !== "none" && (s.taxKind !== currentTax.kind || s.taxPct !== currentTax.pct)) {
        tarifa.push(saleRow(s, s.taxCents));
        tarifaTaxes.push(s.taxKind);
      }
      const untaxed = s.taxKind === "none" || (s.taxPct > 0 && s.taxCents === 0);
      if (untaxed && s.baseCents > 0) sinImp.push(saleRow(s, s.taxCents));
    }
  }

  // ── Facturas que declararon el valor sin el descuento del cliente ────
  // Las facturas con descuento del cliente emitidas antes de que el
  // descuento fuera dentro de las líneas (`discountInLines`): la DIAN las
  // ACEPTÓ con el precio de lista, así que declaran base e impuesto de más.
  // No se reescriben (ya son documentos de la DIAN): se corrigen con nota
  // crédito, y eso lo decide el contador. Sólo las aceptadas: una que no lo
  // está sale con el descuento en las líneas cuando se reenvíe.
  const sinDescuento: AuxRow[] = [];
  const sinDescuentoTaxes: DrillTaxKey[] = [];
  let sinDescuentoBase = 0;
  let sinDescuentoDiscount = 0;
  for (const s of input.sales) {
    const u = s.undeclaredDiscount;
    if (!u || input.dianInvoices.get(s.invoiceId)?.state !== "accepted") continue;
    sinDescuento.push({ ...saleRow(s, u.taxCents), baseCents: u.baseCents });
    if (u.taxCents > 0) sinDescuentoTaxes.push(...salesTaxKey(s));
    sinDescuentoBase += u.baseCents;
    sinDescuentoDiscount += u.discountCents;
  }

  // ── Retenciones ──────────────────────────────────────────────────────
  const omitidas: AuxRow[] = [];
  const omitTaxes: DrillTaxKey[] = [];
  const bajoUmbral: AuxRow[] = [];
  const bajoTaxes: DrillTaxKey[] = [];
  const purchaseRow = (p: PurchaseTaxInput, amountCents: number, extra: Partial<AuxRow> = {}): AuxRow => ({
    key: `compras:${p.purchaseId}`,
    kind: "doc",
    dateIso: p.dateIso,
    amountCents,
    docKind: "purchase",
    docId: p.purchaseId,
    document: p.document,
    party: p.supplierName,
    nit: p.supplierTaxId,
    baseCents: purchaseSubtotal(p),
    ...extra,
  });
  for (const p of input.purchases) {
    const doc = { subtotalCents: purchaseSubtotal(p), taxCents: purchaseIva(p) };
    for (const kind of RET_KINDS) {
      const active = input.concepts.filter((c) => c.active && c.kind === kind);
      if (active.length === 0) continue;
      // Lo que la factura debía llevar es lo que sugiere el formulario de
      // compras (`suggestPurchaseRetentions`): UNA retefuente (la de compras,
      // `pickPurchaseRetefuenteConcept`) y la primera reteIVA / reteICA
      // activa — no la suma de todos los conceptos activos del tipo (un
      // comercio con «Transporte de carga» o «Servicios» activos para sus
      // gastos no espera esas retenciones en una compra de insumos).
      const pick = kind === "retefuente" ? pickPurchaseRetefuenteConcept(active) : active[0];
      const pool = pick ? [pick] : [];
      const applicable = applicableConcepts(pool, kind, doc, input.uvtCents);
      const practiced = retOf(p, kind);
      if (applicable.length > 0 && practiced === 0) {
        const expected = applicable.reduce((s, a) => s + a.amountCents, 0);
        omitidas.push(
          purchaseRow(p, expected, {
            key: `compras:${p.purchaseId}:${kind}`,
            conceptName: applicable.map((a) => a.concept.name).join(" + "),
            baseCents: kind === "reteiva" ? doc.taxCents : doc.subtotalCents,
          }),
        );
        omitTaxes.push(kind);
      } else if (applicable.length === 0 && practiced > 0) {
        bajoUmbral.push(
          purchaseRow(p, practiced, {
            key: `compras:${p.purchaseId}:${kind}`,
            conceptName: pool.map((c) => c.name).join(" · "),
          }),
        );
        bajoTaxes.push(kind);
      }
    }
  }

  // Gastos: misma revisión, pero un gasto es UNA cosa (arriendo, servicio,
  // honorarios…): de retefuente se espera sólo el concepto que le queda a
  // su categoría (`pickRetefuenteConcept`, el mismo de la sugerencia del
  // formulario), no la suma de todos los activos.
  const expenseRow = (e: ExpenseTaxInput, amountCents: number, extra: Partial<AuxRow> = {}): AuxRow => ({
    key: `gastos:${e.expenseId}`,
    kind: "doc",
    dateIso: e.dateIso,
    amountCents,
    docKind: "expense",
    docId: e.expenseId,
    document: e.document,
    party: e.supplierName,
    nit: e.supplierTaxId,
    baseCents: e.baseCents,
    ...extra,
  });
  for (const e of input.expenses ?? []) {
    const doc = { subtotalCents: e.baseCents, taxCents: e.ivaCents };
    for (const kind of RET_KINDS) {
      const active = input.concepts.filter((c) => c.active && c.kind === kind);
      if (active.length === 0) continue;
      // El concepto que le toca al gasto (antes del umbral): de retefuente,
      // el de su categoría; de reteIVA y reteICA, el primero activo.
      let pool = active.slice(0, 1);
      if (kind === "retefuente") {
        const pick = pickRetefuenteConcept(
          active.map((c, i) => ({ ...c, id: String(i), accountCode: "" })),
          { category: e.category },
        );
        pool = pick ? [active[Number(pick.id)]!] : pool;
      }
      const applicable = applicableConcepts(pool, kind, doc, input.uvtCents);
      const practiced = kind === "retefuente" ? e.retefuenteCents : kind === "reteiva" ? e.reteIvaCents : e.reteIcaCents;
      if (applicable.length > 0 && practiced === 0) {
        omitidas.push(
          expenseRow(e, applicable.reduce((s, a) => s + a.amountCents, 0), {
            key: `gastos:${e.expenseId}:${kind}`,
            conceptName: applicable.map((a) => a.concept.name).join(" + "),
            baseCents: kind === "reteiva" ? doc.taxCents : doc.subtotalCents,
          }),
        );
        omitTaxes.push(kind);
      } else if (applicable.length === 0 && practiced > 0) {
        bajoUmbral.push(
          expenseRow(e, practiced, {
            key: `gastos:${e.expenseId}:${kind}`,
            conceptName: pool.map((c) => c.name).join(" · "),
          }),
        );
        bajoTaxes.push(kind);
      }
    }
  }

  // ── IVA descontable sin ser responsable ─────────────────────────────
  const ivaReason = !input.purchaseIvaDeductible ? "config" : currentTax.kind !== "iva" ? "regime" : null;
  const ivaRows: AuxRow[] = [];
  if (ivaReason) {
    for (const f of input.docs) {
      if (f.tax !== "iva" || (f.origin !== "compras" && f.origin !== "gastos") || f.taxCents >= 0) continue;
      ivaRows.push(docAuxRow(f, { amountCents: -f.taxCents, entryId: entryFor(f) }));
    }
  }

  // ── Terceros sin NIT en compras con impuestos ───────────────────────
  const nitRows: AuxRow[] = [];
  const nitTaxes: DrillTaxKey[] = [];
  const byPurchase = new Map<string, DocFact[]>();
  for (const f of input.docs) {
    if (f.origin !== "compras" && f.origin !== "gastos") continue;
    if (f.taxCents === 0 || !f.docId) continue;
    const list = byPurchase.get(f.docId) ?? [];
    list.push(f);
    byPurchase.set(f.docId, list);
  }
  for (const [, facts] of byPurchase) {
    const first = facts[0]!;
    const issue = supplierTaxIdIssue(first.nit);
    if (!issue) continue;
    nitRows.push({
      ...docAuxRow(first, { amountCents: facts.reduce((s, f) => s + Math.abs(f.taxCents), 0), flags: [issue] }),
      key: `${first.origin}:${first.docId}`,
      pct: null,
      conceptName: null,
      baseCents: null,
    });
    nitTaxes.push(...facts.map((f) => f.tax));
  }

  // ── Notas crédito del período ───────────────────────────────────────
  const notas = input.docs.filter((f) => f.origin === "notas");
  const notasRows = notas.map((f) => docAuxRow(f, { entryId: entryFor(f) }));

  // ── Variación inusual (contra el promedio de los períodos con cifra) ─
  const spikes: SpikeDetail[] = [];
  for (const [tax, series] of Object.entries(input.trend ?? {}) as [DrillTaxKey, readonly number[]][]) {
    const spike = detectSpike(series);
    if (spike) spikes.push({ tax, ...spike });
  }

  out.push(result("dianRechazada", rejected.rows, { taxes: rejected.taxes }));
  out.push(result("sinAsiento", sinAsiento, { taxes: taxesOf(recon.rows.sinAsiento) }));
  out.push(result("desactualizado", desactualizado, { taxes: taxesOf(recon.rows.desactualizado) }));
  out.push(
    result("sinFactura", sinFactura, {
      taxes: taxesOf(recon.rows.sinFactura),
      params: { orders: new Set(recon.rows.sinFactura.map((f) => f.docId)).size },
    }),
  );
  out.push(result("cuentaAnulada", cuentaAnulada, { taxes: taxesOf(recon.rows.cuentaAnulada) }));
  out.push(result("dianPendiente", pending.rows, { taxes: pending.taxes }));
  out.push(
    result("tarifaDistinta", tarifa, {
      taxes: uniq(tarifaTaxes),
      params: { kind: currentTax.kind, pct: currentTax.pct },
    }),
  );
  out.push(
    result("sinImpuesto", sinImp, {
      taxes: currentTax.kind === "none" ? [] : [currentTax.kind],
      amountCents: sinImp.reduce((s, r) => s + (r.baseCents ?? 0), 0),
      params: { kind: currentTax.kind, pct: currentTax.pct },
    }),
  );
  out.push(
    result("descuentoSinDeclarar", sinDescuento, {
      taxes: uniq(sinDescuentoTaxes),
      params: { baseCents: sinDescuentoBase, discountCents: sinDescuentoDiscount },
    }),
  );
  out.push(result("retencionOmitida", omitidas, { taxes: uniq(omitTaxes) }));
  out.push(result("retencionBajoUmbral", bajoUmbral, { taxes: uniq(bajoTaxes) }));
  out.push(result("ivaNoDescontable", ivaRows, { taxes: ivaRows.length ? ["iva"] : [], params: { reason: ivaReason ?? "" } }));
  out.push(result("terceroSinNit", nitRows, { taxes: uniq(nitTaxes) }));
  out.push(result("corte", corte, { taxes: taxesOf(recon.rows.corte) }));
  out.push(result("sinDocumento", sinDocumento, { taxes: taxesOf(recon.rows.sinDocumento) }));
  out.push(result("notasCredito", notasRows, { taxes: taxesOf(notas) }));
  // Facturas emitidas antes de cobrar y todavía sin cobrar: información,
  // no hallazgo. La DIAN ya las tiene; su venta (y su impuesto) entra al
  // período en que se cobren, o se anulan con nota crédito si el cliente se
  // fue.
  const pendientes = input.pendingPaymentSales ?? [];
  out.push(
    result(
      "facturadaPendiente",
      pendientes.map((s) => saleRow(s, s.taxCents, ["pendingPayment"])),
      { taxes: uniq(pendientes.flatMap(salesTaxKey)) },
    ),
  );
  out.push({
    ...result("variacion", [], { taxes: spikes.map((s) => s.tax), count: spikes.length, amountCents: 0 }),
    spikes,
  });

  // Toda fila de documento lleva el asiento del motor que la contabilizó
  // (el de su fuente y su día de negocio), salvo las que justamente no lo
  // tienen («sin asiento»).
  const voucherOf = new Map<string, string | null>();
  for (const e of input.entries) voucherOf.set(e.id, e.voucher ?? null);
  const fillEntry = (r: AuxRow): AuxRow => {
    if (r.kind !== "doc" || r.entryId || r.flags?.includes("noEntry") || !r.dateIso || !r.docKind) return r;
    const origin = ORIGIN_OF_KIND[r.docKind];
    if (!origin) return r;
    const day = engineDay(origin, r.dateIso, input.cutoffHour);
    const id = day ? entryOf.get(`${ORIGIN_SOURCE[origin]}|${day}`) : undefined;
    return id ? { ...r, entryId: id, voucher: voucherOf.get(id) ?? null, day: r.day ?? day } : r;
  };
  return out.map((c) => ({ ...c, rows: c.rows.map(fillEntry) }));
}

const ORIGIN_OF_KIND: Partial<Record<NonNullable<AuxRow["docKind"]>, DrillOrigin>> = {
  invoice: "ventas",
  order: "ventas",
  credit_note: "notas",
  purchase: "compras",
  expense: "gastos",
};

/**
 * Salto inusual del último período frente al promedio de los anteriores
 * CON cifra (hacen falta al menos 3): ±50 % o más. Devuelve null si no hay
 * con qué comparar o el cambio es menor.
 */
export function detectSpike(
  series: readonly number[],
): { currentCents: number; averageCents: number; changePct: number } | null {
  if (series.length < 4) return null;
  const current = series[series.length - 1]!;
  const prev = series.slice(0, -1).filter((v) => v !== 0);
  if (prev.length < 3) return null;
  const average = Math.round(prev.reduce((s, v) => s + v, 0) / prev.length);
  if (average === 0) return null;
  const changePct = Math.round(((current - average) / Math.abs(average)) * 100);
  if (Math.abs(changePct) < 50) return null;
  return { currentCents: current, averageCents: average, changePct };
}

/** Las revisiones con hallazgos primero (por severidad y orden), luego las que pasaron. */
export function sortChecks(checks: readonly CheckResult[]): CheckResult[] {
  const rank: Record<CheckSeverity, number> = { critical: 0, warning: 1, info: 2 };
  return [...checks].sort(
    (a, b) =>
      Number(a.count === 0) - Number(b.count === 0) ||
      rank[a.severity] - rank[b.severity] ||
      CHECK_ORDER.indexOf(a.key) - CHECK_ORDER.indexOf(b.key),
  );
}
