// Notas crédito de proveedores — LECTURA (lista, detalle). Todo filtrado por
// comercio. Una nota tiene decenas de filas por comercio y mes: la lista
// filtra en SQL y calcula saldos y resumen en memoria sobre lo filtrado.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeDocumentNumber } from "./documentNumber";
import { periodToUtcRange } from "./reports/period";
import { findSupplierByTaxId } from "./supplierTaxId";
import { loadCreditUsage } from "./supplierCreditNoteService";
import { creditNoteAvailableCents, isSupplierCreditNoteKind, SUPPLIER_CREDIT_NOTE_KINDS } from "./supplierCreditNotes";
import {
  CREDIT_NOTE_PAGE_SIZE,
  type CreditNoteListPage,
  type CreditNoteListParams,
  type CreditNoteRow,
  type CreditNoteSummary,
} from "./supplierCreditNoteList";

function emptyByKind(): CreditNoteSummary["byKind"] {
  return Object.fromEntries(SUPPLIER_CREDIT_NOTE_KINDS.map((k) => [k, 0])) as CreditNoteSummary["byKind"];
}

export async function loadCreditNoteListPage(
  restaurantId: string,
  params: CreditNoteListParams,
): Promise<CreditNoteListPage> {
  const where: Prisma.SupplierCreditNoteWhereInput = { restaurantId };
  if (params.supplier) where.supplierId = params.supplier;
  if (params.kind !== "all") where.kind = params.kind;
  if (params.status === "voided") where.status = "voided";
  if (params.status === "active" || params.status === "with_balance") where.status = "active";
  if (params.from || params.to) {
    const { from, to } = periodToUtcRange({ desde: params.from || "2020-01-01", hasta: params.to || "2100-12-31" });
    where.date = { gte: from, lt: to };
  }
  const q = params.q.trim();
  if (q) {
    where.OR = [
      { number: { contains: q, mode: "insensitive" } },
      { cude: { contains: q, mode: "insensitive" } },
      { agreement: { contains: q, mode: "insensitive" } },
      { supplier: { name: { contains: q, mode: "insensitive" } } },
      { supplier: { taxId: { contains: q.replace(/[^0-9]/g, "") || q } } },
    ];
  }
  const notes = await db.supplierCreditNote.findMany({
    where,
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      number: true,
      date: true,
      kind: true,
      agreement: true,
      totalCents: true,
      ivaCents: true,
      status: true,
      cude: true,
      attachmentUrl: true,
      supplier: { select: { id: true, name: true, taxId: true } },
    },
  });
  const usage = await loadCreditUsage(db, restaurantId, notes.map((n) => n.id));
  let rows: CreditNoteRow[] = notes
    .filter((n) => isSupplierCreditNoteKind(n.kind))
    .map((n) => {
      const u = usage.get(n.id) ?? { appliedCents: 0, refundedCents: 0 };
      return {
        id: n.id,
        number: n.number,
        date: n.date.toISOString(),
        kind: n.kind as CreditNoteRow["kind"],
        agreement: n.agreement,
        supplier: n.supplier,
        totalCents: n.totalCents,
        ivaCents: n.ivaCents,
        appliedCents: u.appliedCents,
        refundedCents: u.refundedCents,
        availableCents: creditNoteAvailableCents({ ...u, totalCents: n.totalCents, status: n.status }),
        status: n.status === "voided" ? "voided" : "active",
        hasCude: Boolean(n.cude),
        attachmentUrl: n.attachmentUrl,
      };
    });
  if (params.status === "with_balance") rows = rows.filter((r) => r.availableCents > 0);

  const summary: CreditNoteSummary = { count: 0, totalCents: 0, availableCents: 0, byKind: emptyByKind() };
  for (const r of rows) {
    if (r.status === "voided") continue;
    summary.count += 1;
    summary.totalCents += r.totalCents;
    summary.availableCents += r.availableCents;
    summary.byKind[r.kind] += r.totalCents;
  }
  const pageCount = Math.max(1, Math.ceil(rows.length / CREDIT_NOTE_PAGE_SIZE));
  const page = Math.min(params.page, pageCount);
  return {
    rows: rows.slice((page - 1) * CREDIT_NOTE_PAGE_SIZE, page * CREDIT_NOTE_PAGE_SIZE),
    total: rows.length,
    page,
    pageSize: CREDIT_NOTE_PAGE_SIZE,
    summary,
  };
}

export type CreditNoteApplicationDto = {
  id: string;
  kind: "purchase" | "expense";
  docId: string;
  /** Factura del proveedor / documento del gasto, si lo tiene. */
  number: string | null;
  purchaseNumber: number | null;
  concept: string | null;
  docDate: string;
  amountCents: number;
  /** ISO del cruce. */
  at: string;
};

export type CreditNoteDetail = {
  id: string;
  number: string;
  date: string;
  cude: string | null;
  kind: string;
  agreement: string | null;
  totalCents: number;
  ivaPct: number;
  ivaCents: number;
  ivaDeductible: boolean;
  incCents: number;
  accountCode: string | null;
  accountName: string | null;
  note: string | null;
  attachmentUrl: string | null;
  status: string;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  supplier: { id: string; name: string; taxId: string | null };
  invoices: { id: string; number: number; supplierInvoiceNumber: string | null }[];
  lines: {
    id: string;
    ingredient: { id: string; name: string; measureKind: string };
    qtyBase: number;
    valueCents: number;
    costCents: number;
    inventoried: boolean;
  }[];
  applications: CreditNoteApplicationDto[];
  refunds: { id: string; amountCents: number; receivedAt: string; accountCode: string; accountName: string | null; note: string | null }[];
  appliedCents: number;
  refundedCents: number;
  availableCents: number;
};

export async function loadCreditNoteDetail(restaurantId: string, id: string): Promise<CreditNoteDetail | null> {
  const n = await db.supplierCreditNote.findFirst({
    where: { id, restaurantId },
    include: {
      supplier: { select: { id: true, name: true, taxId: true } },
      invoices: { include: { purchaseOrder: { select: { id: true, number: true, supplierInvoiceNumber: true } } } },
      lines: {
        orderBy: { id: "asc" },
        include: { ingredient: { select: { id: true, name: true, measureKind: true } } },
      },
      purchasePayments: {
        orderBy: { paidAt: "asc" },
        include: {
          purchaseOrder: { select: { id: true, number: true, supplierInvoiceNumber: true, createdAt: true, receivedAt: true } },
        },
      },
      expensePayments: {
        orderBy: { paidAt: "asc" },
        include: { expense: { select: { id: true, documentNumber: true, category: true, description: true, date: true } } },
      },
      refunds: { orderBy: { receivedAt: "asc" } },
    },
  });
  if (!n) return null;
  const codes = [...new Set([n.accountCode, ...n.refunds.map((r) => r.accountCode)].filter((c): c is string => !!c))];
  const accounts = codes.length
    ? await db.ledgerAccount.findMany({ where: { restaurantId, code: { in: codes } }, select: { code: true, name: true } })
    : [];
  const name = new Map(accounts.map((a) => [a.code, a.name]));
  const applications: CreditNoteApplicationDto[] = [
    ...n.purchasePayments.map((p) => ({
      id: p.id,
      kind: "purchase" as const,
      docId: p.purchaseOrderId,
      number: p.purchaseOrder.supplierInvoiceNumber,
      purchaseNumber: p.purchaseOrder.number,
      concept: null,
      docDate: (p.purchaseOrder.receivedAt ?? p.purchaseOrder.createdAt).toISOString(),
      amountCents: p.amountCents,
      at: p.paidAt.toISOString(),
    })),
    ...n.expensePayments.map((p) => ({
      id: p.id,
      kind: "expense" as const,
      docId: p.expenseId,
      number: p.expense.documentNumber,
      purchaseNumber: null,
      concept: p.expense.description || p.expense.category,
      docDate: p.expense.date.toISOString(),
      amountCents: p.amountCents,
      at: p.paidAt.toISOString(),
    })),
  ];
  const appliedCents = applications.reduce((s, a) => s + a.amountCents, 0);
  const refundedCents = n.refunds.reduce((s, r) => s + r.amountCents, 0);
  return {
    id: n.id,
    number: n.number,
    date: n.date.toISOString(),
    cude: n.cude,
    kind: n.kind,
    agreement: n.agreement,
    totalCents: n.totalCents,
    ivaPct: n.ivaPct,
    ivaCents: n.ivaCents,
    ivaDeductible: n.ivaDeductible,
    incCents: n.incCents,
    accountCode: n.accountCode,
    accountName: n.accountCode ? (name.get(n.accountCode) ?? null) : null,
    note: n.note,
    attachmentUrl: n.attachmentUrl,
    status: n.status,
    voidedAt: n.voidedAt?.toISOString() ?? null,
    voidReason: n.voidReason,
    createdAt: n.createdAt.toISOString(),
    supplier: n.supplier,
    invoices: n.invoices.map((i) => i.purchaseOrder),
    lines: n.lines.map((l) => ({
      id: l.id,
      ingredient: l.ingredient,
      qtyBase: l.qtyBase,
      valueCents: l.valueCents,
      costCents: l.costCents,
      inventoried: l.inventoried,
    })),
    applications,
    refunds: n.refunds.map((r) => ({
      id: r.id,
      amountCents: r.amountCents,
      receivedAt: r.receivedAt.toISOString(),
      accountCode: r.accountCode,
      accountName: name.get(r.accountCode) ?? null,
      note: r.note,
    })),
    appliedCents,
    refundedCents,
    availableCents: creditNoteAvailableCents({ totalCents: n.totalCents, appliedCents, refundedCents, status: n.status }),
  };
}

/** Compras del proveedor que una nota puede referenciar (recibidas o en curso, no anuladas). */
export async function loadSupplierInvoicesForNote(restaurantId: string, supplierId: string) {
  const rows = await db.purchaseOrder.findMany({
    where: { restaurantId, supplierId, status: { in: ["received", "partially_received", "sent"] } },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: {
      id: true,
      number: true,
      status: true,
      createdAt: true,
      receivedAt: true,
      supplierInvoiceNumber: true,
      items: {
        select: {
          id: true,
          ingredientId: true,
          receivedQtyBase: true,
          receivedCostCents: true,
          ingredient: { select: { id: true, name: true, measureKind: true } },
        },
      },
    },
  });
  return rows.map((po) => ({
    id: po.id,
    number: po.number,
    status: po.status,
    date: (po.receivedAt ?? po.createdAt).toISOString(),
    supplierInvoiceNumber: po.supplierInvoiceNumber,
    items: po.items
      .filter((it) => it.receivedQtyBase > 0)
      .map((it) => ({
        id: it.id,
        ingredient: it.ingredient,
        receivedQtyBase: it.receivedQtyBase,
        receivedCostCents: it.receivedCostCents,
      })),
  }));
}

/** Proveedor por NIT y compras del proveedor cuyos números cita la nota. */
export async function resolvePrefillRefs(
  restaurantId: string,
  taxId: string | null,
  invoiceNumbers: readonly string[],
): Promise<{ supplierId: string | null; relatedPurchaseIds: string[] }> {
  if (!taxId) return { supplierId: null, relatedPurchaseIds: [] };
  const suppliers = await db.supplier.findMany({
    where: { restaurantId, taxId: { not: null } },
    select: { id: true, taxId: true },
  });
  const supplierId = findSupplierByTaxId(suppliers, taxId)?.id ?? null;
  if (!supplierId || invoiceNumbers.length === 0) return { supplierId, relatedPurchaseIds: [] };
  const keys = new Set(invoiceNumbers.map(normalizeDocumentNumber).filter((k): k is string => !!k));
  const pos = await db.purchaseOrder.findMany({
    where: { restaurantId, supplierId, status: { not: "canceled" }, supplierInvoiceNumber: { not: null } },
    select: { id: true, supplierInvoiceNumber: true },
  });
  return {
    supplierId,
    relatedPurchaseIds: pos.filter((p) => keys.has(normalizeDocumentNumber(p.supplierInvoiceNumber) ?? "")).map((p) => p.id),
  };
}

