/**
 * IMPUESTOS DEL PERÍODO — modelo del DESPLIEGUE en tres niveles (lógica
 * pura, sin DB ni React). Responde a «¿qué generó este impuesto?»:
 *
 *   Nivel 1  un renglón por impuesto del resumen para la DIAN (INC, IVA,
 *            retefuente, reteIVA, reteICA): cifra de los DOCUMENTOS, cifra
 *            del LIBRO y la diferencia.
 *   Nivel 2  el desglose: por ORIGEN y TARIFA/CONCEPTO del lado documental
 *            (ventas · INC 8 %, notas crédito · IVA 19 %, compras ·
 *            «Compras (2,5 %)»…) y por FUENTE del asiento del lado del libro
 *            (ventas del día, compras del día, comprobantes manuales…).
 *   Nivel 3  los AUXILIARES: los documentos (`DocFact`) y las líneas del
 *            libro (`LedgerFact`) que suman cada renglón del nivel 2.
 *
 * Todo sale de dos listas planas de HECHOS, y cada nivel es una suma de
 * los hechos del nivel de abajo: los totales concilian por construcción
 * (Σ nivel 3 = renglón del nivel 2; Σ nivel 2 = renglón del nivel 1), sin
 * redondeos intermedios (centavos enteros). Los tests lo comprueban contra
 * `aggregateDocumentTaxes` y `buildTaxAccountReport`, que siguen siendo la
 * fuente de las cifras.
 *
 * SIGNOS: el impuesto de cada hecho es su APORTE al saldo del renglón de
 * nivel 1 (las notas crédito, las devoluciones y el IVA descontable de las
 * compras RESTAN); la base va siempre positiva, como en el formulario de la
 * DIAN, donde la sección dice si suma o resta.
 *
 * ORÍGENES: «gastos» es un origen más: los gastos con IVA, INC o
 * retenciones se mapean con `expenseFacts` (ver `taxesDrillReport.ts`,
 * `extraDocFacts`); el libro trae sus líneas por la fuente `expense`.
 */
import { embeddedTaxCents } from "../accounting";
import { formatVoucherNumber, isAnnulled } from "./generalLedger";
import type { RetentionLedgerLine } from "./taxesDetail";
import {
  dominantSalesTax,
  purchaseLineTaxCents,
  type CreditNoteTaxInput,
  type CurrentSalesTax,
  type ExpenseTaxInput,
  type PurchaseTaxInput,
  type SaleTaxInput,
} from "./taxesDocuments";
import { classifyTaxAccount, signedMovement, type FamilyKey, type TaxAccount } from "./taxesModel";

// ── Claves ────────────────────────────────────────────────────────────────

export type DrillTaxKey = "inc" | "iva" | "retefuente" | "reteiva" | "reteica";

/** Orden de lectura del resumen (el INC primero: es el de los restaurantes). */
export const DRILL_TAXES: readonly DrillTaxKey[] = ["inc", "iva", "retefuente", "reteiva", "reteica"];

export type DrillOrigin = "ventas" | "notas" | "devoluciones" | "compras" | "gastos";

export const DRILL_ORIGINS: readonly DrillOrigin[] = ["ventas", "notas", "devoluciones", "compras", "gastos"];

/** Fuente del asiento del motor que contabiliza cada origen documental. */
export const ORIGIN_SOURCE: Record<DrillOrigin, string> = {
  ventas: "sale",
  notas: "credit_note",
  devoluciones: "refund",
  compras: "purchase",
  gastos: "expense",
};

/** Origen documental de una fuente del libro (null = asiento sin documento: manual, pago…). */
export function originOfSource(source: string): DrillOrigin | null {
  for (const o of DRILL_ORIGINS) if (ORIGIN_SOURCE[o] === source) return o;
  return null;
}

/** Familia del libro que corresponde a cada impuesto del resumen. */
export const TAX_FAMILY: Record<DrillTaxKey, FamilyKey> = {
  inc: "consumo",
  iva: "iva",
  retefuente: "retefuente",
  reteiva: "reteiva",
  reteica: "reteica",
};

function taxOfFamily(family: FamilyKey): DrillTaxKey | null {
  for (const k of DRILL_TAXES) if (TAX_FAMILY[k] === family) return k;
  return null;
}

/** Id del renglón de otros movimientos del libro (familias sin documento). */
export const OTHERS_ID = "otros";

// ── Hechos ────────────────────────────────────────────────────────────────

export type DocKind = "invoice" | "credit_note" | "refund" | "purchase" | "expense" | "order";

/** Un documento (o la parte de un documento) que aporta a un impuesto. */
export type DocFact = {
  /** Único entre todos los hechos documentales. */
  key: string;
  tax: DrillTaxKey;
  origin: DrillOrigin;
  /** Tarifa del renglón de nivel 2: «8», «19», «250» (bps de retención), «e325» (efectiva), «x». */
  rateKey: string;
  /** Tarifa para mostrar, en % (null = el documento no la discrimina). */
  pct: number | null;
  /** Concepto de retención que explica la tarifa, si alguno calza. */
  conceptName: string | null;
  docKind: DocKind;
  /** Id del documento fuente (factura, nota, compra, gasto, pedido). */
  docId: string | null;
  /** Número legal (FE123, NC4, factura del proveedor u OC-0007). */
  document: string | null;
  /** Notas crédito: la factura que ajustan. */
  reference: string | null;
  /** ISO del instante del documento. */
  dateIso: string;
  party: string | null;
  nit: string | null;
  /** Base gravable (siempre ≥ 0). */
  baseCents: number;
  /** Aporte al saldo del impuesto (negativo si resta). */
  taxCents: number;
  /** Compras: IVA registrado en el documento (descontable + no descontable). */
  grossTaxCents: number | null;
  /** Compras: parte del IVA que NO es descontable (va al costo/gasto). */
  nonDeductibleCents: number | null;
};

/** Una línea del libro sobre una cuenta tributaria. */
export type LedgerFact = {
  key: string;
  /** Impuesto del resumen al que pertenece; null = otra familia tributaria. */
  tax: DrillTaxKey | null;
  family: FamilyKey;
  source: string;
  entryId: string;
  voucher: string | null;
  dateIso: string;
  accountCode: string;
  accountName: string;
  /** Movimiento con el signo de la naturaleza de la cuenta (positivo = crece). */
  valueCents: number;
  party: string | null;
  nit: string | null;
  memo: string | null;
  voided: boolean;
};

const signOf = (tax: DrillTaxKey, origin: DrillOrigin): 1 | -1 => {
  if (origin === "notas" || origin === "devoluciones") return -1;
  // IVA de compras y gastos = descontable: resta del generado. Las
  // retenciones de compras y gastos son lo que el comercio debe consignar.
  if ((origin === "compras" || origin === "gastos") && tax === "iva") return -1;
  return 1;
};

/**
 * Facturas de venta → hechos: uno por factura con tarifa (lo embebido de la
 * carta; las de base y tarifa en cero no aportan) y uno por cada tramo que
 * sus líneas libres suman encima (`SaleTaxInput.freeLineSlices`).
 */
export function salesFacts(sales: readonly SaleTaxInput[]): DocFact[] {
  const out: DocFact[] = [];
  for (const s of sales) {
    if (s.taxKind === "none") continue;
    if (s.taxCents === 0 && s.baseCents === 0) continue;
    out.push({
      key: `inv:${s.invoiceId}`,
      tax: s.taxKind,
      origin: "ventas",
      rateKey: String(s.taxPct),
      pct: s.taxPct,
      conceptName: null,
      docKind: "invoice",
      docId: s.invoiceId,
      document: s.document,
      reference: null,
      dateIso: s.dateIso,
      party: s.customer?.name ?? null,
      nit: s.customer?.docNumber ?? null,
      baseCents: s.baseCents,
      taxCents: s.taxCents,
      grossTaxCents: null,
      nonDeductibleCents: null,
    });
  }
  // Lo que las LÍNEAS LIBRES de cada factura suman ENCIMA: un hecho por
  // factura y tramo, como lo asienta el motor («Ventas del día»).
  for (const s of sales) {
    for (const f of s.freeLineSlices ?? []) {
      if (f.kind === "none" || (f.taxCents === 0 && f.baseCents === 0)) continue;
      out.push({
        key: `inv:${s.invoiceId}:libre:${f.kind}:${f.pct}`,
        tax: f.kind,
        origin: "ventas",
        rateKey: String(f.pct),
        pct: f.pct,
        conceptName: null,
        docKind: "invoice",
        docId: s.invoiceId,
        document: s.document,
        reference: null,
        dateIso: s.dateIso,
        party: s.customer?.name ?? null,
        nit: s.customer?.docNumber ?? null,
        baseCents: f.baseCents,
        taxCents: f.taxCents,
        grossTaxCents: null,
        nonDeductibleCents: null,
      });
    }
  }
  return out;
}

/** Notas crédito aceptadas → un hecho NEGATIVO por nota y tarifa. */
export function creditNoteFacts(notes: readonly CreditNoteTaxInput[]): DocFact[] {
  const out: DocFact[] = [];
  for (const n of notes) {
    for (const sl of n.slices) {
      if (sl.kind === "none") continue;
      out.push({
        key: `nc:${n.creditNoteId}:${sl.kind}:${sl.pct}`,
        tax: sl.kind,
        origin: "notas",
        rateKey: String(sl.pct),
        pct: sl.pct,
        conceptName: null,
        docKind: "credit_note",
        docId: n.creditNoteId,
        document: n.document,
        reference: n.reference,
        dateIso: n.dateIso,
        party: n.customer?.name ?? null,
        nit: n.customer?.docNumber ?? null,
        baseCents: sl.baseCents,
        taxCents: -sl.taxCents,
        grossTaxCents: null,
        nonDeductibleCents: null,
      });
    }
  }
  return out;
}

/**
 * Reembolsos de la pasarela SIN nota crédito: no hay documento que congele
 * su impuesto; se estima con el tramo dominante del período, igual que
 * `aggregateDocumentTaxes` y el asiento `refund` del motor. Un solo hecho.
 */
export function refundFacts(
  refundsCents: number,
  sales: readonly SaleTaxInput[],
  currentTax: CurrentSalesTax,
  dateIso: string,
): DocFact[] {
  if (!(refundsCents > 0)) return [];
  const dominant = dominantSalesTax(sales, currentTax);
  if (dominant.kind === "none") return [];
  const tax = embeddedTaxCents(refundsCents, dominant.pct);
  return [
    {
      key: "refunds",
      tax: dominant.kind,
      origin: "devoluciones",
      rateKey: String(dominant.pct),
      pct: dominant.pct,
      conceptName: null,
      docKind: "refund",
      docId: null,
      document: null,
      reference: null,
      dateIso,
      party: null,
      nit: null,
      baseCents: refundsCents - tax,
      taxCents: -tax,
      grossTaxCents: null,
      nonDeductibleCents: null,
    },
  ];
}

/** Concepto de retención para emparejar la tarifa de un documento. */
export type RetentionConceptRate = { kind: string; name: string; rateBps: number; active: boolean };

/**
 * Tarifa de una retención de cabecera: el concepto del comercio cuya tarifa
 * reproduce EXACTAMENTE el valor retenido sobre la base (mismo redondeo que
 * `computeRetentions`), con preferencia por el activo. Si ninguno calza,
 * la tarifa efectiva en puntos básicos; sin base, «x».
 */
export function retentionRate(
  kind: string,
  baseCents: number,
  amountCents: number,
  concepts: readonly RetentionConceptRate[],
): { rateKey: string; pct: number | null; conceptName: string | null } {
  const matches = concepts.filter(
    (c) => c.kind === kind && baseCents > 0 && Math.round((baseCents * c.rateBps) / 10_000) === amountCents,
  );
  const best = matches.find((c) => c.active) ?? matches[0];
  if (best) return { rateKey: String(best.rateBps), pct: best.rateBps / 100, conceptName: best.name };
  if (!(baseCents > 0)) return { rateKey: "x", pct: null, conceptName: null };
  const bps = Math.round((amountCents * 10_000) / baseCents);
  return { rateKey: `e${bps}`, pct: bps / 100, conceptName: null };
}

/**
 * Compras recibidas → hechos de IVA (una por compra y tarifa, con el
 * DESCONTABLE como aporte negativo) y de retenciones (una por compra y
 * clase, positiva). Mismas reglas que `aggregateDocumentTaxes`: una línea
 * sin IVA y sin tarifa no aporta; la base de reteIVA es el IVA.
 */
export function purchaseFacts(
  purchases: readonly PurchaseTaxInput[],
  concepts: readonly RetentionConceptRate[] = [],
  origin: Extract<DrillOrigin, "compras" | "gastos"> = "compras",
): DocFact[] {
  const out: DocFact[] = [];
  const docKind: DocKind = origin === "gastos" ? "expense" : "purchase";
  for (const p of purchases) {
    const base = (key: string) => ({
      origin,
      docKind,
      docId: p.purchaseId,
      document: p.document,
      reference: null,
      dateIso: p.dateIso,
      party: p.supplierName,
      nit: p.supplierTaxId,
      key: `${origin}:${p.purchaseId}:${key}`,
    });
    const byPct = new Map<number, { net: number; tax: number; nonDed: number }>();
    let netTotal = 0;
    let ivaTotal = 0;
    for (const l of p.lines) {
      const tax = l.taxCents ?? purchaseLineTaxCents(l.netCents, l.taxPct);
      netTotal += l.netCents;
      ivaTotal += tax;
      if (tax === 0 && !(l.taxPct > 0)) continue;
      const acc = byPct.get(l.taxPct) ?? { net: 0, tax: 0, nonDed: 0 };
      acc.net += l.netCents;
      acc.tax += tax;
      acc.nonDed += l.nonDeductibleTaxCents;
      byPct.set(l.taxPct, acc);
    }
    for (const [pct, acc] of [...byPct].sort((a, b) => b[0] - a[0])) {
      out.push({
        ...base(`iva:${pct}`),
        tax: "iva",
        rateKey: String(pct),
        pct,
        conceptName: null,
        baseCents: acc.net,
        taxCents: signOf("iva", origin) * (acc.tax - acc.nonDed),
        grossTaxCents: acc.tax,
        nonDeductibleCents: acc.nonDed,
      });
    }
    const ret = (kind: "retefuente" | "reteiva" | "reteica", amount: number, b: number) => {
      if (amount === 0) return;
      const rate = retentionRate(kind, b, amount, concepts);
      out.push({
        ...base(kind),
        tax: kind,
        ...rate,
        baseCents: b,
        taxCents: signOf(kind, origin) * amount,
        grossTaxCents: null,
        nonDeductibleCents: null,
      });
    };
    ret("retefuente", p.retefuenteCents, netTotal);
    ret("reteiva", p.reteIvaCents, ivaTotal);
    ret("reteica", p.reteIcaCents, netTotal);
  }
  return out;
}

/**
 * Gastos con impuestos → hechos del origen «gastos» (lo que asienta el
 * motor en el asiento `expense` por la fecha contable del gasto):
 *
 *  · IVA: uno por gasto, con el DESCONTABLE como aporte negativo (D 2408)
 *    y el no descontable aparte (`nonDeductibleCents`: va al costo, el
 *    aporte es 0). Tarifa del gasto; IVA impreso sin tarifa → la efectiva.
 *  · INC: uno por gasto, aporte 0 (el INC de un gasto es costo, nunca
 *    impuesto a pagar), con el valor en `grossTaxCents` para verlo.
 *  · Retenciones: una por concepto practicado (la foto guardada en el
 *    gasto: nombre y tarifa), positiva (C 2365/2367/2368). Sin líneas
 *    (datos sueltos), una por tipo con la tarifa que calce.
 */
export function expenseFacts(
  expenses: readonly ExpenseTaxInput[],
  concepts: readonly RetentionConceptRate[] = [],
): DocFact[] {
  const out: DocFact[] = [];
  for (const e of expenses) {
    const base = (key: string) => ({
      origin: "gastos" as const,
      docKind: "expense" as const,
      docId: e.expenseId,
      document: e.document,
      reference: null,
      dateIso: e.dateIso,
      party: e.supplierName,
      nit: e.supplierTaxId,
      key: `gastos:${e.expenseId}:${key}`,
    });
    if (e.ivaCents !== 0 || e.ivaPct > 0) {
      const nonDed = Math.max(0, Math.min(e.ivaCents, e.nonDeductibleIvaCents));
      const effective = e.ivaPct === 0 && e.ivaCents > 0 && e.baseCents > 0
        ? Math.round((e.ivaCents * 10_000) / e.baseCents)
        : null;
      out.push({
        ...base(`iva:${e.ivaPct}`),
        tax: "iva",
        rateKey: effective != null ? `e${effective}` : String(e.ivaPct),
        pct: effective != null ? effective / 100 : e.ivaPct,
        conceptName: null,
        baseCents: e.baseCents,
        taxCents: signOf("iva", "gastos") * (e.ivaCents - nonDed) || 0,
        grossTaxCents: e.ivaCents,
        nonDeductibleCents: nonDed,
      });
    }
    if (e.incCents > 0) {
      out.push({
        ...base("inc"),
        tax: "inc",
        rateKey: "x",
        pct: null,
        conceptName: null,
        baseCents: e.baseCents,
        taxCents: 0,
        grossTaxCents: e.incCents,
        nonDeductibleCents: e.incCents,
      });
    }
    const lines = e.retentions ?? [];
    const kinds = ["retefuente", "reteiva", "reteica"] as const;
    const totalOf = (k: (typeof kinds)[number]) =>
      k === "retefuente" ? e.retefuenteCents : k === "reteiva" ? e.reteIvaCents : e.reteIcaCents;
    for (const kind of kinds) {
      const mine = lines.filter((l) => l.kind === kind && l.amountCents !== 0);
      const listed = mine.reduce((s, l) => s + l.amountCents, 0);
      mine.forEach((l, i) => {
        out.push({
          ...base(`${kind}:${i}`),
          tax: kind,
          rateKey: String(l.rateBps),
          pct: l.rateBps / 100,
          conceptName: l.name,
          baseCents: l.baseCents,
          taxCents: signOf(kind, "gastos") * l.amountCents,
          grossTaxCents: null,
          nonDeductibleCents: null,
        });
      });
      // Lo que los totales del gasto dicen y las líneas no explican (datos
      // sin líneas): un hecho con la tarifa que calce, para que Σ cuadre.
      const rest = totalOf(kind) - listed;
      if (rest !== 0) {
        const b = kind === "reteiva" ? e.ivaCents : e.baseCents;
        out.push({
          ...base(kind),
          tax: kind,
          ...retentionRate(kind, b, rest, concepts),
          baseCents: b,
          taxCents: signOf(kind, "gastos") * rest,
          grossTaxCents: null,
          nonDeductibleCents: null,
        });
      }
    }
  }
  return out;
}

/**
 * Líneas del libro → hechos, clasificadas por familia (concepto de retención
 * primero, luego el prefijo PUC más largo, luego la naturaleza) y con el
 * signo de la naturaleza, igual que `buildTaxAccountReport`.
 */
export function ledgerFacts(
  lines: readonly RetentionLedgerLine[],
  accounts: readonly TaxAccount[],
  conceptKindByCode?: ReadonlyMap<string, string>,
): LedgerFact[] {
  const byCode = new Map<string, TaxAccount>();
  for (const a of accounts) byCode.set(a.code, a);
  const out: LedgerFact[] = [];
  for (const l of lines) {
    const account = byCode.get(l.accountCode) ?? {
      code: l.accountCode,
      name: "",
      type: l.accountCode.startsWith("2") ? "pasivo" : "activo",
    };
    const valueCents = signedMovement(account.type, l);
    if (valueCents === 0) continue;
    const family = classifyTaxAccount(l.accountCode, account.type, conceptKindByCode?.get(l.accountCode));
    out.push({
      key: l.id,
      tax: taxOfFamily(family),
      family,
      source: l.source,
      entryId: l.entryId,
      voucher: formatVoucherNumber(l.voucherNumber),
      dateIso: l.dateIso,
      accountCode: l.accountCode,
      accountName: account.name,
      valueCents,
      party: l.thirdPartyName ?? null,
      nit: l.thirdPartyTaxId ?? null,
      memo: l.memo ?? null,
      voided: isAnnulled(l.status),
    });
  }
  return out;
}

// ── Árbol ─────────────────────────────────────────────────────────────────

export type DrillDocNode = {
  /** `${tax}-${origin}-${rateKey}` (va a la URL en `?abrir=`). */
  id: string;
  tax: DrillTaxKey;
  origin: DrillOrigin;
  rateKey: string;
  pct: number | null;
  conceptName: string | null;
  count: number;
  baseCents: number;
  taxCents: number;
};

export type DrillBookNode = {
  /** `${tax}-libro-${source}`. */
  id: string;
  tax: DrillTaxKey;
  source: string;
  origin: DrillOrigin | null;
  /** Comprobantes distintos que mueven el renglón. */
  count: number;
  valueCents: number;
};

export type DrillStatus = "ok" | "diff" | "empty";

export type DrillTax = {
  key: DrillTaxKey;
  /** Σ aportes de los documentos (el saldo del impuesto según documentos). */
  docCents: number;
  /** Σ movimiento del libro en la familia del impuesto. */
  bookCents: number;
  /** libro − documentos. */
  diffCents: number;
  status: DrillStatus;
  docNodes: DrillDocNode[];
  bookNodes: DrillBookNode[];
};

export type DrillOtherNode = {
  /** `otros-${family}`. */
  id: string;
  family: FamilyKey;
  count: number;
  valueCents: number;
};

export type TaxDrill = {
  taxes: DrillTax[];
  others: { nodes: DrillOtherNode[]; valueCents: number };
};

export type DrillFacts = { docs: readonly DocFact[]; ledger: readonly LedgerFact[] };

export function docNodeId(tax: DrillTaxKey, origin: DrillOrigin, rateKey: string): string {
  return `${tax}-${origin}-${rateKey}`;
}

export function bookNodeId(tax: DrillTaxKey, source: string): string {
  return `${tax}-libro-${source}`;
}

export function otherNodeId(family: FamilyKey): string {
  return `${OTHERS_ID}-${family}`;
}

/** Orden de las fuentes del libro: las del motor como los orígenes, el resto alfabético y lo manual al final. */
function sourceRank(source: string): number {
  const o = originOfSource(source);
  if (o) return DRILL_ORIGINS.indexOf(o);
  if (source === "manual") return 99;
  return 50;
}

const statusOf = (doc: number, book: number, hasRows: boolean): DrillStatus =>
  !hasRows && doc === 0 && book === 0 ? "empty" : doc === book ? "ok" : "diff";

/** Arma los niveles 1 y 2 a partir de los hechos. */
export function buildTaxDrill({ docs, ledger }: DrillFacts): TaxDrill {
  const taxes: DrillTax[] = DRILL_TAXES.map((tax) => {
    const docMap = new Map<string, DrillDocNode>();
    for (const f of docs) {
      if (f.tax !== tax) continue;
      const id = docNodeId(tax, f.origin, f.rateKey);
      const n = docMap.get(id) ?? {
        id,
        tax,
        origin: f.origin,
        rateKey: f.rateKey,
        pct: f.pct,
        conceptName: f.conceptName,
        count: 0,
        baseCents: 0,
        taxCents: 0,
      };
      n.count += 1;
      n.baseCents += f.baseCents;
      n.taxCents += f.taxCents;
      docMap.set(id, n);
    }
    const bookMap = new Map<string, DrillBookNode & { entries: Set<string> }>();
    for (const l of ledger) {
      if (l.tax !== tax) continue;
      const id = bookNodeId(tax, l.source);
      const n = bookMap.get(id) ?? {
        id,
        tax,
        source: l.source,
        origin: originOfSource(l.source),
        count: 0,
        valueCents: 0,
        entries: new Set<string>(),
      };
      n.entries.add(l.entryId);
      n.valueCents += l.valueCents;
      bookMap.set(id, n);
    }
    const docNodes = [...docMap.values()].sort(
      (a, b) =>
        DRILL_ORIGINS.indexOf(a.origin) - DRILL_ORIGINS.indexOf(b.origin) ||
        (b.pct ?? -1) - (a.pct ?? -1) ||
        a.rateKey.localeCompare(b.rateKey),
    );
    const bookNodes: DrillBookNode[] = [...bookMap.values()]
      .map(({ entries, ...n }) => ({ ...n, count: entries.size }))
      .sort((a, b) => sourceRank(a.source) - sourceRank(b.source) || a.source.localeCompare(b.source));
    const docCents = docNodes.reduce((s, n) => s + n.taxCents, 0);
    const bookCents = bookNodes.reduce((s, n) => s + n.valueCents, 0);
    return {
      key: tax,
      docCents,
      bookCents,
      diffCents: bookCents - docCents,
      status: statusOf(docCents, bookCents, docNodes.length + bookNodes.length > 0),
      docNodes,
      bookNodes,
    };
  });

  const otherMap = new Map<FamilyKey, DrillOtherNode & { entries: Set<string> }>();
  for (const l of ledger) {
    if (l.tax !== null) continue;
    const n = otherMap.get(l.family) ?? {
      id: otherNodeId(l.family),
      family: l.family,
      count: 0,
      valueCents: 0,
      entries: new Set<string>(),
    };
    n.entries.add(l.entryId);
    n.valueCents += l.valueCents;
    otherMap.set(l.family, n);
  }
  const otherNodes = [...otherMap.values()]
    .map(({ entries, ...n }) => ({ ...n, count: entries.size }))
    .sort((a, b) => a.family.localeCompare(b.family));
  return {
    taxes,
    others: { nodes: otherNodes, valueCents: otherNodes.reduce((s, n) => s + n.valueCents, 0) },
  };
}

/**
 * Impuestos que siempre se muestran, aunque el período no tenga cifra: la
 * retención en la fuente es mensual y obligatoria para quien la practica, y
 * verla en $0 es información (no «falta»). El INC/IVA del régimen también.
 */
const ALWAYS_VISIBLE: readonly DrillTaxKey[] = ["retefuente"];

/** Los impuestos que vale la pena mostrar: con cifra o renglones, más los de siempre. */
export function visibleTaxes(drill: TaxDrill, regime: CurrentSalesTax["kind"]): DrillTax[] {
  return drill.taxes.filter(
    (t) => t.status !== "empty" || t.key === regime || ALWAYS_VISIBLE.includes(t.key),
  );
}

// ── Nivel 3: auxiliares ───────────────────────────────────────────────────

export type AuxSelection =
  | { kind: "docs"; rows: DocFact[] }
  | { kind: "ledger"; rows: LedgerFact[] };

const byDate = <T extends { dateIso: string; key: string }>(a: T, b: T) =>
  a.dateIso.localeCompare(b.dateIso) || a.key.localeCompare(b.key);

/**
 * Hechos que forman un renglón del árbol (nivel 2, o «otros-*»). null si
 * el id no es de un renglón con auxiliares.
 */
export function selectAux(facts: DrillFacts, nodeId: string): AuxSelection | null {
  for (const tax of DRILL_TAXES) {
    const bookPrefix = `${tax}-libro-`;
    if (nodeId.startsWith(bookPrefix)) {
      const source = nodeId.slice(bookPrefix.length);
      const rows = facts.ledger.filter((l) => l.tax === tax && l.source === source);
      return { kind: "ledger", rows: [...rows].sort(byDate) };
    }
  }
  if (nodeId.startsWith(`${OTHERS_ID}-`)) {
    const family = nodeId.slice(OTHERS_ID.length + 1);
    const rows = facts.ledger.filter((l) => l.tax === null && l.family === family);
    return { kind: "ledger", rows: [...rows].sort(byDate) };
  }
  const rows = facts.docs.filter((f) => docNodeId(f.tax, f.origin, f.rateKey) === nodeId);
  if (rows.length > 0) return { kind: "docs", rows: [...rows].sort(byDate) };
  // Un renglón documental válido sin filas no existe en el árbol; un id
  // desconocido tampoco: el llamador responde 404.
  return null;
}

/** Σ de una selección: base e impuesto (documentos) o movimiento (libro). */
export function sumSelection(sel: AuxSelection): { baseCents: number; valueCents: number; count: number } {
  if (sel.kind === "docs") {
    return {
      baseCents: sel.rows.reduce((s, r) => s + r.baseCents, 0),
      valueCents: sel.rows.reduce((s, r) => s + r.taxCents, 0),
      count: sel.rows.length,
    };
  }
  return { baseCents: 0, valueCents: sel.rows.reduce((s, r) => s + r.valueCents, 0), count: sel.rows.length };
}

/** Página `page` (desde 1) de `size` filas. */
export function paginate<T>(rows: readonly T[], page: number, size: number): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, page), pages);
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages };
}
