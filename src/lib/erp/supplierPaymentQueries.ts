// «Pagar a proveedor» — LECTURA: lista de comprobantes de egreso y detalle
// (para la pantalla y el comprobante imprimible). Todo por comercio.
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export const SUPPLIER_PAYMENTS_PATH = "/operator/compras/pagos";
export const SUPPLIER_PAYMENT_PAGE_SIZE = 25;

export type SupplierPaymentRow = {
  id: string;
  number: number;
  date: string;
  supplier: { id: string; name: string; taxId: string | null };
  accountCode: string;
  accountName: string | null;
  method: string | null;
  reference: string | null;
  amountCents: number;
  creditAppliedCents: number;
  advanceCents: number;
  status: "active" | "voided";
};

async function accountNames(restaurantId: string, codes: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(codes)];
  if (!unique.length) return new Map();
  const rows = await db.ledgerAccount.findMany({ where: { restaurantId, code: { in: unique } }, select: { code: true, name: true } });
  return new Map(rows.map((r) => [r.code, r.name]));
}

export async function loadSupplierPaymentList(
  restaurantId: string,
  params: { supplierId?: string | null; page?: number },
): Promise<{ rows: SupplierPaymentRow[]; total: number; page: number; pageSize: number; totals: { paidCents: number; creditsCents: number; advanceCents: number } }> {
  const where: Prisma.SupplierPaymentWhereInput = { restaurantId, ...(params.supplierId ? { supplierId: params.supplierId } : {}) };
  const page = Math.max(1, params.page ?? 1);
  const [rows, total, sums] = await Promise.all([
    db.supplierPayment.findMany({
      where,
      orderBy: [{ number: "desc" }],
      skip: (page - 1) * SUPPLIER_PAYMENT_PAGE_SIZE,
      take: SUPPLIER_PAYMENT_PAGE_SIZE,
      include: { supplier: { select: { id: true, name: true, taxId: true } } },
    }),
    db.supplierPayment.count({ where }),
    db.supplierPayment.aggregate({
      where: { ...where, status: "active" },
      _sum: { amountCents: true, creditAppliedCents: true, advanceCents: true },
    }),
  ]);
  const names = await accountNames(restaurantId, rows.map((r) => r.accountCode));
  return {
    rows: rows.map((r) => ({
      id: r.id,
      number: r.number,
      date: r.date.toISOString(),
      supplier: r.supplier,
      accountCode: r.accountCode,
      accountName: names.get(r.accountCode) ?? null,
      method: r.method,
      reference: r.reference,
      amountCents: r.amountCents,
      creditAppliedCents: r.creditAppliedCents,
      advanceCents: r.advanceCents,
      status: r.status === "voided" ? "voided" : "active",
    })),
    total,
    page,
    pageSize: SUPPLIER_PAYMENT_PAGE_SIZE,
    totals: {
      paidCents: sums._sum.amountCents ?? 0,
      creditsCents: sums._sum.creditAppliedCents ?? 0,
      advanceCents: sums._sum.advanceCents ?? 0,
    },
  };
}

export type SupplierPaymentDetail = SupplierPaymentRow & {
  note: string | null;
  attachmentUrl: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  /** Una fila por documento: lo cruzado (notas/anticipos) y lo pagado en dinero. */
  docs: Array<{
    kind: "purchase" | "expense";
    id: string;
    number: string | null;
    purchaseNumber: number | null;
    concept: string | null;
    creditCents: number;
    moneyCents: number;
  }>;
  /** Saldos a favor cruzados: nota (número) o anticipo (comprobante). */
  credits: Array<{ source: "note" | "advance"; label: string; amountCents: number }>;
  advanceUsedCents: number;
};

export async function loadSupplierPaymentDetail(restaurantId: string, id: string): Promise<SupplierPaymentDetail | null> {
  const p = await db.supplierPayment.findFirst({
    where: { id, restaurantId },
    include: {
      supplier: { select: { id: true, name: true, taxId: true } },
      purchaseRows: {
        include: {
          purchaseOrder: { select: { id: true, number: true, supplierInvoiceNumber: true } },
          supplierCreditNote: { select: { number: true } },
          supplierAdvance: { select: { number: true } },
        },
      },
      expenseRows: {
        include: {
          expense: { select: { id: true, documentNumber: true, category: true, description: true } },
          supplierCreditNote: { select: { number: true } },
          supplierAdvance: { select: { number: true } },
        },
      },
      advancePurchaseUses: { select: { amountCents: true } },
      advanceExpenseUses: { select: { amountCents: true } },
    },
  });
  if (!p) return null;
  const names = await accountNames(restaurantId, [p.accountCode]);
  const docs = new Map<string, SupplierPaymentDetail["docs"][number]>();
  const credits = new Map<string, SupplierPaymentDetail["credits"][number]>();
  const add = (
    key: string,
    base: Omit<SupplierPaymentDetail["docs"][number], "creditCents" | "moneyCents">,
    row: { amountCents: number; supplierCreditNote: { number: string } | null; supplierAdvance: { number: number } | null },
  ) => {
    const d = docs.get(key) ?? { ...base, creditCents: 0, moneyCents: 0 };
    if (row.supplierCreditNote || row.supplierAdvance) {
      d.creditCents += row.amountCents;
      const ck = row.supplierCreditNote ? `n:${row.supplierCreditNote.number}` : `a:${row.supplierAdvance!.number}`;
      const c = credits.get(ck) ?? {
        source: row.supplierCreditNote ? ("note" as const) : ("advance" as const),
        label: row.supplierCreditNote ? row.supplierCreditNote.number : String(row.supplierAdvance!.number),
        amountCents: 0,
      };
      c.amountCents += row.amountCents;
      credits.set(ck, c);
    } else d.moneyCents += row.amountCents;
    docs.set(key, d);
  };
  for (const r of p.purchaseRows) {
    add(`p:${r.purchaseOrderId}`, { kind: "purchase", id: r.purchaseOrderId, number: r.purchaseOrder.supplierInvoiceNumber, purchaseNumber: r.purchaseOrder.number, concept: null }, r);
  }
  for (const r of p.expenseRows) {
    add(`e:${r.expenseId}`, { kind: "expense", id: r.expenseId, number: r.expense.documentNumber, purchaseNumber: null, concept: r.expense.description || r.expense.category }, r);
  }
  const advanceUsedCents = [...p.advancePurchaseUses, ...p.advanceExpenseUses].reduce((s, r) => s + r.amountCents, 0);
  return {
    id: p.id,
    number: p.number,
    date: p.date.toISOString(),
    supplier: p.supplier,
    accountCode: p.accountCode,
    accountName: names.get(p.accountCode) ?? null,
    method: p.method,
    reference: p.reference,
    amountCents: p.amountCents,
    creditAppliedCents: p.creditAppliedCents,
    advanceCents: p.advanceCents,
    status: p.status === "voided" ? "voided" : "active",
    note: p.note,
    attachmentUrl: p.attachmentUrl,
    voidedAt: p.voidedAt?.toISOString() ?? null,
    voidReason: p.voidReason,
    createdAt: p.createdAt.toISOString(),
    docs: [...docs.values()],
    credits: [...credits.values()],
    advanceUsedCents,
  };
}
