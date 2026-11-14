/**
 * Capa de BASE DE DATOS de los reportes de impuestos (`taxesReport.ts` la
 * compone; `taxesDocuments.ts`, `taxesModel.ts`, `taxesCross.ts` y
 * `taxesDetail.ts` son puros). Devuelve datos crudos con la forma que
 * esperan las funciones puras; no calcula nada.
 *
 * Fuentes:
 *  · VENTAS: `SimpleInvoice` de cuentas pagadas en el rango (mismo corte
 *    `order.paidAt` que `computeTaxSummary` / `fiscal.ts`), leyendo del
 *    snapshot la tarifa y el impuesto CONGELADOS (`frozenSalesTax`). El
 *    adquiriente sale del snapshot (`customer`) y, si la factura no lo
 *    guardó, del `InvoiceRequest` generado de la cuenta.
 *  · COMPRAS: `PurchaseOrder` recibidas en el rango (`receivedAt`), con
 *    líneas (IVA por `taxPct`) y retenciones de cabecera.
 *  · NOTAS CRÉDITO: `CreditNote` ACEPTADAS por la DIAN (no descartadas)
 *    con fecha fiscal (día colombiano de `DianDocument.issuedAt`) en el
 *    período; base e impuesto por tarifa de su `snapshot.lines`. El
 *    tercero es el de la factura original, con la misma regla que las
 *    ventas. Una nota que no cuadra al centavo se excluye (y se loguea).
 *  · DEVOLUCIONES: reembolsos de la pasarela (`KushkiTransaction` kind
 *    refund) SIN nota crédito ligada, como `posting.ts`.
 *  · LIBRO: líneas de `JournalLine` del rango sobre las cuentas de las
 *    familias (por prefijo PUC + cuentas de los conceptos de retención),
 *    con los datos del comprobante. Sin filtro por `status`: el anulado
 *    por reversa conserva sus líneas y la reversa las netea (ver
 *    `queries.ts`).
 *
 *  · GASTOS: `Expense` (no plantillas) con fecha contable en el rango e
 *    IVA, INC o retenciones capturados — origen aparte de las compras
 *    (`loadExpenseTaxDocs`). Los gastos sin impuestos no aportan nada.
 *
 * Fechas: límites UTC (`from` inclusivo, `to` EXCLUSIVO), ver `period.ts`.
 * Consultas parametrizadas (`Prisma.sql`), nunca por interpolación.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  PURCHASE_IN_MOVEMENTS_SELECT,
  PURCHASE_LINE_AMOUNTS_SELECT,
  purchaseOrderTotals,
  RECEIVED_VAT_LINE_SELECT,
  receivedNonDeductibleTaxByLine,
  receivedPurchaseLineAmounts,
} from "@/lib/erp/purchaseTax";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";
import { saleTaxOfSnapshot, undeclaredDiscountOf } from "./saleTaxSnapshot";
import type { CreditNoteSnapshot } from "@/lib/dian/creditNotes/types";
import {
  acceptedCreditNoteWhere,
  creditNoteInstant,
  inFiscalRange,
  issuedAtWindow,
  loadUnlinkedRefundsCents,
  logInvalidCreditNote,
  storedNoteSlices,
} from "../creditNoteAccounting";
import { creditNoteFiscalDate } from "../creditNoteLedger";
import type {
  CreditNoteTaxInput,
  SupplierCreditNoteTaxInput,
  CurrentSalesTax,
  ExpenseTaxInput,
  PurchaseTaxInput,
  SaleTaxInput,
} from "./taxesDocuments";
import { expenseBaseCents, expenseHref } from "../expenseTax";
import { conceptRateBps } from "../retencionesCore";

export { expenseHref };
import { centsToNumber, type StoredCents } from "../ledgerCents";
// Las mismas definiciones que el motor (`posting.ts`) para el impuesto de
// las líneas libres.
import { FREE_LINES_INCLUDE, toFreeLines } from "../accountingData";
import { orderFreeLineTaxSlices } from "../salesTaxSlices";
import type { RetentionLedgerLine } from "./taxesDetail";
import type { TaxAccount } from "./taxesModel";
import { expenseDocumentLabel } from "@/lib/erp/expenseNumberFormat";

/** Consecutivo de la OC como documento cuando no se capturó la factura del proveedor. */
export function purchaseDocumentLabel(
  supplierInvoiceNumber: string | null | undefined,
  number: number,
): string {
  const trimmed = supplierInvoiceNumber?.trim();
  return trimmed ? trimmed : `OC-${String(number).padStart(4, "0")}`;
}

type SaleCustomer = SaleTaxInput["customer"];

/**
 * Adquiriente de una factura: el que congeló el snapshot o, si no lo
 * guardó, la última solicitud de factura generada de la cuenta.
 */
function saleCustomer(
  snap: InvoiceSnapshot,
  request: { customerName: string; docType: string; docNumber: string } | undefined,
): SaleCustomer {
  return snap.customer
    ? { name: snap.customer.name, docType: snap.customer.docType, docNumber: snap.customer.docNumber }
    : request
      ? { name: request.customerName, docType: request.docType, docNumber: request.docNumber }
      : null;
}

const GENERATED_REQUEST = {
  where: { status: "generated" as const },
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { customerName: true, docType: true, docNumber: true },
};

const SALE_DOC_SELECT = {
  id: true,
  invoiceNumber: true,
  snapshot: true,
  order: {
    select: {
      paidAt: true,
      subtotalCents: true,
      invoiceRequests: GENERATED_REQUEST,
      // Sólo para las tirillas anteriores a que el snapshot guardara el
      // tipo de impuesto de cada ítem (ver `orderFreeLineTaxSlices`).
      items: FREE_LINES_INCLUDE,
    },
  },
} as const;

export async function loadSaleTaxDocs(
  restaurantId: string,
  from: Date,
  to: Date,
): Promise<SaleTaxInput[]> {
  const rows = await db.simpleInvoice.findMany({
    where: { restaurantId, order: { paidAt: { gte: from, lt: to } } },
    select: SALE_DOC_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(saleTaxInputOf);
}

/**
 * Facturas emitidas ANTES de cobrar, en el período (por su emisión), cuya
 * cuenta todavía no se cobró. No entran a los documentos del período (la
 * venta entra el día que se cobra, como en el motor) ni son un error: la
 * revisión «facturadaPendiente» las lista como información, porque la DIAN
 * sí las tiene. Las de cuentas canceladas (factura anulada, el cliente se
 * fue) no van: se netean con su nota crédito.
 */
export async function loadPendingPaymentSaleDocs(
  restaurantId: string,
  from: Date,
  to: Date,
): Promise<SaleTaxInput[]> {
  const rows = await db.simpleInvoice.findMany({
    where: {
      restaurantId,
      createdAt: { gte: from, lt: to },
      order: { paidAt: null, status: { not: "cancelled" } },
    },
    select: SALE_DOC_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(saleTaxInputOf);
}

type SaleDocRow = Prisma.SimpleInvoiceGetPayload<{ select: typeof SALE_DOC_SELECT }>;

function saleTaxInputOf(r: SaleDocRow): SaleTaxInput {
  const snap = r.snapshot as unknown as InvoiceSnapshot;
  // Tarifa congelada, impuesto y base: una sola definición, compartida
  // con la tendencia del despliegue (`saleTaxSnapshot.ts`).
  const frozen = saleTaxOfSnapshot(snap);
  const { taxCents, baseCents } = frozen;
  const customer = saleCustomer(snap, r.order.invoiceRequests[0]);
  // Lo que las líneas libres suman encima: el MISMO tramo que asienta el motor.
  const freeLineSlices = orderFreeLineTaxSlices({
    subtotalCents: r.order.subtotalCents,
    invoiceSnapshot: snap,
    freeLines: toFreeLines(r.order.items),
  }).map(({ kind, pct, baseCents, taxCents }) => ({ kind, pct, baseCents, taxCents }));
  // Factura vieja con descuento que declaró el precio de lista: cuánto de
  // más (la revisión «descuentoSinDeclarar»). No cambia lo declarado.
  const undeclaredDiscount = undeclaredDiscountOf(snap);
  return {
    invoiceId: r.id,
    document: formatInvoiceNumber(snap, r.invoiceNumber),
    dateIso: (r.order.paidAt ?? new Date(snap.paidAtIso)).toISOString(),
    taxKind: frozen.kind,
    taxPct: frozen.pct,
    baseCents,
    taxCents,
    ...(freeLineSlices.length > 0 ? { freeLineSlices } : {}),
    customer,
    ...(undeclaredDiscount ? { undeclaredDiscount } : {}),
  };
}

export async function loadPurchaseTaxDocs(
  restaurantId: string,
  from: Date,
  to: Date,
): Promise<PurchaseTaxInput[]> {
  const rows = await db.purchaseOrder.findMany({
    where: { restaurantId, receivedAt: { gte: from, lt: to } },
    orderBy: { receivedAt: "asc" },
    select: {
      id: true,
      number: true,
      receivedAt: true,
      supplierInvoiceNumber: true,
      incCents: true,
      retefuenteCents: true,
      reteIvaCents: true,
      reteIcaCents: true,
      supplier: { select: { name: true, taxId: true } },
      items: {
        select: {
          ...PURCHASE_LINE_AMOUNTS_SELECT,
          ...RECEIVED_VAT_LINE_SELECT,
        },
      },
      movements: PURCHASE_IN_MOVEMENTS_SELECT,
    },
  });
  return rows.map((p) => ({
    purchaseId: p.id,
    document: purchaseDocumentLabel(p.supplierInvoiceNumber, p.number),
    dateIso: (p.receivedAt ?? new Date(0)).toISOString(),
    supplierName: p.supplier.name,
    supplierTaxId: p.supplier.taxId,
    lines: p.items.map((i, idx) => ({
      netCents: i.receivedCostCents,
      taxPct: i.taxPct,
      taxCents: receivedPurchaseLineAmounts(i).taxCents,
      // Misma definición que el asiento «Compras del día»: lo que la
      // recepción dejó en el costo (inventario o gasto) no es descontable.
      nonDeductibleTaxCents: receivedNonDeductibleTaxByLine(p.items, p.movements ?? [])[idx]!,
    })),
    incCents: purchaseOrderTotals(p, "received").incCents,
    retefuenteCents: p.retefuenteCents,
    reteIvaCents: p.reteIvaCents,
    reteIcaCents: p.reteIcaCents,
  }));
}

/**
 * Gastos del rango con impuestos o retenciones (origen «gastos»). `date`
 * es una FECHA contable (mediodía de Colombia): cae en el día que eligió
 * el operador con los límites UTC del período.
 */
export async function loadExpenseTaxDocs(
  restaurantId: string,
  from: Date,
  to: Date,
): Promise<ExpenseTaxInput[]> {
  const rows = await db.expense.findMany({
    where: {
      restaurantId,
      recurring: false,
      date: { gte: from, lt: to },
      OR: [
        { ivaCents: { gt: 0 } },
        { incCents: { gt: 0 } },
        { retefuenteCents: { gt: 0 } },
        { reteIvaCents: { gt: 0 } },
        { reteIcaCents: { gt: 0 } },
      ],
    },
    orderBy: { date: "asc" },
    select: {
      id: true,
      date: true,
      category: true,
      number: true,
      documentType: true,
      documentNumber: true,
      amountCents: true,
      baseCents: true,
      ivaPct: true,
      ivaCents: true,
      ivaDeductible: true,
      incCents: true,
      retefuenteCents: true,
      reteIvaCents: true,
      reteIcaCents: true,
      retentions: {
        orderBy: { createdAt: "asc" },
        select: { kind: true, name: true, rateBps: true, ratePpm: true, baseCents: true, amountCents: true },
      },
      supplier: { select: { name: true, taxId: true } },
    },
  });
  return rows.map((e) => ({
    expenseId: e.id,
    document: expenseDocumentLabel(e, e.category),
    dateIso: e.date.toISOString(),
    category: e.category,
    documentType: e.documentType,
    supplierName: e.supplier?.name ?? null,
    supplierTaxId: e.supplier?.taxId ?? null,
    baseCents: expenseBaseCents(e),
    ivaPct: e.ivaPct,
    ivaCents: e.ivaCents,
    nonDeductibleIvaCents: e.ivaDeductible ? 0 : e.ivaCents,
    incCents: e.incCents,
    retefuenteCents: e.retefuenteCents,
    reteIvaCents: e.reteIvaCents,
    reteIcaCents: e.reteIcaCents,
    // Tarifa efectiva (con decimales finos si la foto trae ratePpm).
    retentions: e.retentions.map(({ ratePpm, ...r }) => ({ ...r, rateBps: conceptRateBps({ rateBps: r.rateBps, ratePpm }) })),
    href: expenseHref(e.id, e.date),
  }));
}

/**
 * Notas crédito de PROVEEDORES con IVA o INC discriminado: las fechadas en
 * el rango restan; las anuladas en el rango devuelven (como el reverso del
 * asiento). Las que no discriminan impuestos no tocan el IVA.
 */
export async function loadSupplierCreditNoteTaxDocs(
  restaurantId: string,
  from: Date,
  to: Date,
): Promise<SupplierCreditNoteTaxInput[]> {
  const withTax = { OR: [{ ivaCents: { gt: 0 } }, { incCents: { gt: 0 } }] };
  const select = {
    id: true,
    number: true,
    date: true,
    voidedAt: true,
    ivaPct: true,
    totalCents: true,
    ivaCents: true,
    incCents: true,
    ivaDeductible: true,
    supplier: { select: { name: true, taxId: true } },
  } as const;
  const [notes, voids] = await Promise.all([
    db.supplierCreditNote.findMany({ where: { restaurantId, date: { gte: from, lt: to }, ...withTax }, select }),
    db.supplierCreditNote.findMany({
      where: { restaurantId, status: "voided", voidedAt: { gte: from, lt: to }, ...withTax },
      select,
    }),
  ]);
  const row = (n: (typeof notes)[number], sign: -1 | 1): SupplierCreditNoteTaxInput => ({
    creditNoteId: n.id,
    document: n.number,
    dateIso: (sign === 1 && n.voidedAt ? n.voidedAt : n.date).toISOString(),
    supplierName: n.supplier.name,
    supplierTaxId: n.supplier.taxId,
    sign,
    ivaPct: n.ivaPct,
    baseCents: n.totalCents - n.ivaCents - n.incCents,
    ivaCents: n.ivaCents,
    nonDeductibleIvaCents: n.ivaDeductible ? 0 : n.ivaCents,
    incCents: n.incCents,
  });
  return [...notes.map((n) => row(n, -1)), ...voids.map((n) => row(n, 1))];
}

/**
 * Notas crédito aceptadas con fecha fiscal en [desde, hasta]. Montos
 * POSITIVOS (las funciones puras los restan); referencia = número de la
 * factura original como lo declaró su XML.
 */
export async function loadCreditNoteTaxDocs(
  restaurantId: string,
  desde: string,
  hasta: string,
): Promise<CreditNoteTaxInput[]> {
  const rows = await db.creditNote.findMany({
    where: { ...acceptedCreditNoteWhere(restaurantId), dianDocument: { is: { state: "accepted", issuedAt: issuedAtWindow(desde, hasta) } } },
    select: {
      id: true,
      documentNumber: true,
      subtotalCents: true,
      taxCents: true,
      totalCents: true,
      snapshot: true,
      createdAt: true,
      dianDocument: { select: { issuedAt: true } },
      originalInvoice: {
        select: {
          invoiceNumber: true,
          snapshot: true,
          order: { select: { invoiceRequests: GENERATED_REQUEST } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const out: CreditNoteTaxInput[] = [];
  for (const r of rows) {
    const instant = creditNoteInstant(r);
    if (!inFiscalRange(instant, desde, hasta)) continue;
    const slices = storedNoteSlices(r);
    if (!slices.ok) {
      logInvalidCreditNote(r.id, r.documentNumber, slices.reason);
      continue;
    }
    const invoiceSnap = r.originalInvoice.snapshot as unknown as InvoiceSnapshot;
    const noteSnap = r.snapshot as unknown as CreditNoteSnapshot;
    out.push({
      creditNoteId: r.id,
      document: r.documentNumber,
      reference: noteSnap?.original?.invoiceNumber || formatInvoiceNumber(invoiceSnap, r.originalInvoice.invoiceNumber),
      dateIso: `${creditNoteFiscalDate(instant)}T12:00:00.000Z`,
      customer: saleCustomer(invoiceSnap, r.originalInvoice.order.invoiceRequests[0]),
      slices: slices.slices.map((sl) => ({
        kind: sl.kind,
        pct: sl.pct,
        baseCents: sl.baseCents,
        taxCents: sl.taxCents,
      })),
    });
  }
  return out;
}

/**
 * Σ reembolsos de la pasarela del rango SIN nota crédito ligada (la parte
 * ligada a una nota la resta la nota con su impuesto exacto). Misma regla
 * cronológica que el asiento `refund` de `posting.ts`.
 */
export async function loadRefundsCents(restaurantId: string, from: Date, to: Date): Promise<number> {
  return loadUnlinkedRefundsCents(restaurantId, from, to);
}

/** Tarifa vigente del comercio (para devoluciones de un período sin ventas). */
export async function loadCurrentSalesTax(restaurantId: string): Promise<CurrentSalesTax> {
  const r = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { salesTaxKind: true, salesTaxPct: true },
  });
  const kind = (r?.salesTaxKind ?? "none") as CurrentSalesTax["kind"];
  return { kind, pct: kind === "none" ? 0 : (r?.salesTaxPct ?? 0) };
}

export type RetentionConceptRow = { kind: string; name: string; accountCode: string; active: boolean };

/** Conceptos de retención del comercio (activos e inactivos: nombran la cuenta igual). */
export async function loadRetentionConceptRows(restaurantId: string): Promise<RetentionConceptRow[]> {
  return db.retentionConcept.findMany({
    where: { restaurantId },
    select: { kind: true, name: true, accountCode: true, active: true },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
}

/** Cuentas del plan que caen en los prefijos o en la lista de códigos (inactivas incluidas). */
export async function loadTaxAccounts(
  restaurantId: string,
  prefixes: readonly string[],
  codes: readonly string[] = [],
): Promise<TaxAccount[]> {
  const or: Prisma.LedgerAccountWhereInput[] = prefixes.map((p) => ({ code: { startsWith: p } }));
  if (codes.length) or.push({ code: { in: [...codes] } });
  if (!or.length) return [];
  const rows = await db.ledgerAccount.findMany({
    where: { restaurantId, OR: or },
    select: { code: true, name: true, type: true },
    orderBy: { code: "asc" },
  });
  return rows.map((a) => ({ code: a.code, name: a.name, type: a.type }));
}

type RawTaxLine = {
  id: string;
  entryId: string;
  accountCode: string;
  // BIGINT: SQL crudo los devuelve como bigint.
  debitCents: StoredCents;
  creditCents: StoredCents;
  date: Date;
  voucherNumber: number | null;
  source: string;
  status: string;
  memo: string | null;
  thirdPartyName: string | null;
  thirdPartyTaxId: string | null;
};

/**
 * Líneas del libro del rango sobre las cuentas tributarias (por prefijo
 * PUC y/o código exacto), con los datos del comprobante. TODOS los
 * estados: el anulado por reversa y su reversa suman los dos.
 */
export async function loadTaxLedgerLines(
  restaurantId: string,
  from: Date,
  to: Date,
  prefixes: readonly string[],
  codes: readonly string[] = [],
): Promise<RetentionLedgerLine[]> {
  const conds: Prisma.Sql[] = prefixes.map((p) => Prisma.sql`l."accountCode" LIKE ${`${p}%`}`);
  if (codes.length) conds.push(Prisma.sql`l."accountCode" IN (${Prisma.join([...codes])})`);
  if (!conds.length) return [];
  const rows = await db.$queryRaw<RawTaxLine[]>(Prisma.sql`
    SELECT
      l."id", l."entryId", l."accountCode", l."debitCents", l."creditCents",
      e."date", e."voucherNumber", e."source", e."status", e."memo",
      e."thirdPartyName", e."thirdPartyTaxId"
    FROM "JournalLine" l
    JOIN "JournalEntry" e ON e."id" = l."entryId"
    WHERE e."restaurantId" = ${restaurantId}
      AND e."date" >= ${from}
      AND e."date" < ${to}
      AND (${Prisma.join(conds, " OR ")})
    ORDER BY e."date" ASC, e."voucherNumber" ASC NULLS LAST, l."id" ASC
  `);
  return rows.map((r) => ({
    id: r.id,
    entryId: r.entryId,
    accountCode: r.accountCode,
    debitCents: centsToNumber(r.debitCents),
    creditCents: centsToNumber(r.creditCents),
    dateIso: r.date.toISOString(),
    voucherNumber: r.voucherNumber,
    source: r.source,
    status: r.status,
    memo: r.memo,
    thirdPartyName: r.thirdPartyName,
    thirdPartyTaxId: r.thirdPartyTaxId,
  }));
}
