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
 * Gastos (`Expense`): NO llevan impuesto en el modelo (categoría, monto y
 * cuenta del PUC nada más), así que no aportan al documental.
 *
 * Fechas: límites UTC (`from` inclusivo, `to` EXCLUSIVO), ver `period.ts`.
 * Consultas parametrizadas (`Prisma.sql`), nunca por interpolación.
 */
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { formatInvoiceNumber, frozenSalesTax, type InvoiceSnapshot } from "@/lib/invoice";
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
  CurrentSalesTax,
  PurchaseTaxInput,
  SaleTaxInput,
} from "./taxesDocuments";
import type { RetentionLedgerLine } from "./taxesDetail";
import type { TaxAccount } from "./taxesModel";

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

export async function loadSaleTaxDocs(
  restaurantId: string,
  from: Date,
  to: Date,
): Promise<SaleTaxInput[]> {
  const rows = await db.simpleInvoice.findMany({
    where: { restaurantId, order: { paidAt: { gte: from, lt: to } } },
    select: {
      id: true,
      invoiceNumber: true,
      snapshot: true,
      order: {
        select: {
          paidAt: true,
          invoiceRequests: GENERATED_REQUEST,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => {
    const snap = r.snapshot as unknown as InvoiceSnapshot;
    const frozen = frozenSalesTax(snap);
    const taxCents = frozen.kind === "none" ? 0 : (snap.embeddedTaxCents ?? 0);
    // Base del tramo como en `computeTaxSummary`: lo congelado, o para los
    // snapshots viejos el subtotal entero menos el impuesto.
    const baseCents =
      snap.embeddedBaseCents != null ? snap.embeddedBaseCents : snap.subtotalCents - taxCents;
    const customer = saleCustomer(snap, r.order.invoiceRequests[0]);
    return {
      invoiceId: r.id,
      document: formatInvoiceNumber(snap, r.invoiceNumber),
      dateIso: (r.order.paidAt ?? new Date(snap.paidAtIso)).toISOString(),
      taxKind: frozen.kind,
      taxPct: frozen.pct,
      baseCents,
      taxCents,
      customer,
    };
  });
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
          receivedCostCents: true,
          taxPct: true,
          nonInventoryReceivedNonDeductibleTaxCents: true,
        },
      },
    },
  });
  return rows.map((p) => ({
    purchaseId: p.id,
    document: purchaseDocumentLabel(p.supplierInvoiceNumber, p.number),
    dateIso: (p.receivedAt ?? new Date(0)).toISOString(),
    supplierName: p.supplier.name,
    supplierTaxId: p.supplier.taxId,
    lines: p.items.map((i) => ({
      netCents: i.receivedCostCents,
      taxPct: i.taxPct,
      nonDeductibleTaxCents: i.nonInventoryReceivedNonDeductibleTaxCents,
    })),
    incCents: p.incCents,
    retefuenteCents: p.retefuenteCents,
    reteIvaCents: p.reteIvaCents,
    reteIcaCents: p.reteIcaCents,
  }));
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
  debitCents: number;
  creditCents: number;
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
    debitCents: Number(r.debitCents),
    creditCents: Number(r.creditCents),
    dateIso: r.date.toISOString(),
    voucherNumber: r.voucherNumber,
    source: r.source,
    status: r.status,
    memo: r.memo,
    thirdPartyName: r.thirdPartyName,
    thirdPartyTaxId: r.thirdPartyTaxId,
  }));
}
