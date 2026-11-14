// ¿Este documento de proveedor ya se registró en el comercio?
//
// ── Por qué existe ────────────────────────────────────────────────────────
// Se podía registrar dos veces la misma factura de un proveedor (cargarla
// otra vez con IA, digitarla a mano como compra, o como gasto), y quedaba
// duplicada la cuenta por pagar, el inventario y la contabilidad. Todas las
// vías de alta (compra con IA, compra manual, número de factura de una orden
// recibida, gastos) pasan por `assertNotDuplicateDocument`.
//
// ── Qué cuenta como el mismo documento ────────────────────────────────────
//  · Mismo proveedor: el mismo `supplierId` o, si el proveedor está creado
//    dos veces, el mismo NIT (con o sin dígito de verificación).
//  · Mismo número de factura normalizado (`normalizeDocumentNumber`:
//    «FE-000123» = «fe 123»). Compras Y gastos: la misma factura registrada
//    como compra y luego como gasto también es un duplicado.
//  · No cuentan: compras anuladas, plantillas de gastos recurrentes, el
//    propio documento al editarlo, ni lo de otros comercios.
//  · Sin número de factura no hay cómo saberlo: si coinciden proveedor, día
//    y total sólo se ADVIERTE (`possible_duplicate`) y el operador puede
//    guardar igual. El CUFE/CUDE no se captura hoy en compras ni gastos, así
//    que no participa (si se empieza a guardar, va aquí).
//
// ── Carreras ──────────────────────────────────────────────────────────────
// Dos altas simultáneas de la misma factura: cada una revisa DESPUÉS de
// escribir y bajo un candado transaccional por (comercio, número), así que
// la segunda espera a que la primera confirme y la ve. No hay índice único:
// producción puede tener duplicados viejos y la regla depende de la
// normalización y del NIT, que no caben en un índice.
import type { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { bogotaBusinessDateIso, bogotaDayRange } from "@/lib/bogota";
import { taxIdKeys } from "@/lib/suppliers/supplierSearch";
import { expenseHref, expensePayableCents } from "@/lib/erp/expenseTax";
import { PURCHASE_LINE_AMOUNTS_SELECT, PURCHASE_ORDER_TAX_SELECT, purchaseOrderTotals } from "@/lib/erp/purchaseTax";
import {
  normalizeDocumentNumber,
  type DuplicateConflictCode,
  type ExistingSupplierDocument,
  type PossibleDuplicateMode,
  type SupplierDocumentKind,
} from "@/lib/erp/documentNumber";

type Client = Prisma.TransactionClient;

export type SupplierDocumentCheck = {
  restaurantId: string;
  /** Proveedor del documento (null: aún no existe o el gasto no tiene). */
  supplierId: string | null;
  /** NIT del proveedor cuando todavía no está creado (factura con IA). */
  supplierTaxId?: string | null;
  number: string | null | undefined;
  /** Fecha del documento — sólo para la advertencia sin número. */
  date?: Date;
  /** Total a pagar en centavos — sólo para la advertencia sin número. */
  totalCents?: number;
  /** El propio documento, al editarlo o al revisar después de crearlo. */
  exclude?: { kind: SupplierDocumentKind; id: string };
  possibleDuplicate?: PossibleDuplicateMode;
};

export type DuplicateFinding = { code: DuplicateConflictCode; existing: ExistingSupplierDocument };

export class DuplicateDocumentError extends Error {
  constructor(
    public readonly code: DuplicateConflictCode,
    public readonly existing: ExistingSupplierDocument,
  ) {
    super(code);
    this.name = "DuplicateDocumentError";
  }
}

/** 409 con el documento existente, para que la UI diga cuál es y lo abra. */
export function duplicateDocumentResponse(err: DuplicateDocumentError) {
  return NextResponse.json({ error: err.code, duplicate: err.existing }, { status: 409 });
}

export function purchaseDocumentHref(id: string): string {
  return `/operator/compras?oc=${encodeURIComponent(id)}`;
}

/**
 * Candado de la transacción para el número de factura en el comercio (o
 * para "sin número"): serializa las altas que podrían chocar entre sí. Se
 * suelta solo al confirmar o deshacer la transacción.
 */
export async function lockSupplierDocument(
  tx: Client,
  restaurantId: string,
  number: string | null | undefined,
): Promise<void> {
  const key = `supplier-document:${restaurantId}:${normalizeDocumentNumber(number) ?? "*"}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
}

/**
 * Proveedores que cuentan como "el mismo": el elegido y los del comercio
 * con el mismo NIT (con o sin DV). Sin proveedor ni NIT, ninguno.
 */
export async function sameSupplierIds(
  tx: Client,
  restaurantId: string,
  supplierId: string | null,
  supplierTaxId?: string | null,
): Promise<string[]> {
  const ids = new Set<string>();
  let taxId = supplierTaxId ?? null;
  if (supplierId) {
    const own = await tx.supplier.findFirst({
      where: { id: supplierId, restaurantId },
      select: { id: true, taxId: true },
    });
    if (own) {
      ids.add(own.id);
      taxId = own.taxId ?? taxId;
    }
  }
  const keys = taxIdKeys(taxId);
  if (keys.length > 0) {
    const withTaxId = await tx.supplier.findMany({
      where: { restaurantId, taxId: { not: null } },
      select: { id: true, taxId: true },
    });
    for (const s of withTaxId) {
      if (taxIdKeys(s.taxId).some((k) => keys.includes(k))) ids.add(s.id);
    }
  }
  return [...ids];
}

const PURCHASE_REF_SELECT = {
  id: true,
  number: true,
  status: true,
  createdAt: true,
  supplierInvoiceNumber: true,
  // Impuestos de cabecera que entran al total (incluye los que se agreguen).
  ...PURCHASE_ORDER_TAX_SELECT,
  supplier: { select: { name: true } },
  items: { select: PURCHASE_LINE_AMOUNTS_SELECT },
} satisfies Prisma.PurchaseOrderSelect;

const EXPENSE_REF_SELECT = {
  id: true,
  date: true,
  documentNumber: true,
  amountCents: true,
  payableCents: true,
  supplier: { select: { name: true } },
} satisfies Prisma.ExpenseSelect;

type PurchaseRefRow = Prisma.PurchaseOrderGetPayload<{ select: typeof PURCHASE_REF_SELECT }>;
type ExpenseRefRow = Prisma.ExpenseGetPayload<{ select: typeof EXPENSE_REF_SELECT }>;

/** Lo que se paga de la compra: lo recibido si ya se recibió, si no lo pedido. */
function purchaseTotals(po: PurchaseRefRow): { expected: number; received: number; shown: number } {
  const expected = purchaseOrderTotals(po).totalCents;
  const received = purchaseOrderTotals(po, "received").totalCents;
  const isReceived = po.status === "received" || po.status === "partially_received";
  return { expected, received, shown: isReceived ? received : expected };
}

function purchaseRef(po: PurchaseRefRow): ExistingSupplierDocument {
  return {
    kind: "purchase",
    id: po.id,
    number: po.supplierInvoiceNumber,
    purchaseNumber: po.number,
    date: po.createdAt.toISOString(),
    totalCents: purchaseTotals(po).shown,
    supplierName: po.supplier.name,
    href: purchaseDocumentHref(po.id),
  };
}

function expenseRef(e: ExpenseRefRow): ExistingSupplierDocument {
  return {
    kind: "expense",
    id: e.id,
    number: e.documentNumber,
    purchaseNumber: null,
    date: e.date.toISOString(),
    totalCents: expensePayableCents(e),
    supplierName: e.supplier?.name ?? null,
    href: expenseHref(e.id, e.date),
  };
}

function excludeId(check: SupplierDocumentCheck, kind: SupplierDocumentKind) {
  return check.exclude?.kind === kind ? { id: { not: check.exclude.id } } : {};
}

/**
 * Busca el documento con el que choca `check` (sin escribir nada).
 *  · Con número: la misma factura del mismo proveedor → `duplicate_document`.
 *  · Sin número y `possibleDuplicate: "check"`: mismo proveedor, mismo día
 *    (Bogotá) y mismo total → `possible_duplicate`.
 */
export async function findDuplicateDocument(
  tx: Client,
  check: SupplierDocumentCheck,
): Promise<DuplicateFinding | null> {
  const numberKey = normalizeDocumentNumber(check.number);
  const wantsSoft = !numberKey && check.possibleDuplicate === "check" && check.date != null && check.totalCents != null;
  if (!numberKey && !wantsSoft) return null;
  const supplierIds = await sameSupplierIds(tx, check.restaurantId, check.supplierId, check.supplierTaxId);
  if (supplierIds.length === 0) return null;

  if (numberKey) {
    const purchases = await tx.purchaseOrder.findMany({
      where: {
        restaurantId: check.restaurantId,
        supplierId: { in: supplierIds },
        status: { not: "canceled" },
        supplierInvoiceNumber: { not: null },
        ...excludeId(check, "purchase"),
      },
      orderBy: { createdAt: "asc" },
      select: PURCHASE_REF_SELECT,
    });
    const po = purchases.find((p) => normalizeDocumentNumber(p.supplierInvoiceNumber) === numberKey);
    if (po) return { code: "duplicate_document", existing: purchaseRef(po) };
    const expenses = await tx.expense.findMany({
      where: {
        restaurantId: check.restaurantId,
        supplierId: { in: supplierIds },
        recurring: false,
        documentNumber: { not: null },
        ...excludeId(check, "expense"),
      },
      orderBy: { date: "asc" },
      select: EXPENSE_REF_SELECT,
    });
    const expense = expenses.find((e) => normalizeDocumentNumber(e.documentNumber) === numberKey);
    return expense ? { code: "duplicate_document", existing: expenseRef(expense) } : null;
  }

  // Sin número: mismo proveedor, mismo día calendario en Bogotá y mismo total.
  const { start, end } = bogotaDayRange(bogotaBusinessDateIso(check.date!));
  const total = check.totalCents!;
  const purchases = await tx.purchaseOrder.findMany({
    where: {
      restaurantId: check.restaurantId,
      supplierId: { in: supplierIds },
      status: { not: "canceled" },
      createdAt: { gte: start, lt: end },
      ...excludeId(check, "purchase"),
    },
    orderBy: { createdAt: "asc" },
    select: PURCHASE_REF_SELECT,
  });
  const po = purchases.find((p) => {
    const totals = purchaseTotals(p);
    return totals.expected === total || totals.received === total;
  });
  if (po) return { code: "possible_duplicate", existing: purchaseRef(po) };
  const expenses = await tx.expense.findMany({
    where: {
      restaurantId: check.restaurantId,
      supplierId: { in: supplierIds },
      recurring: false,
      date: { gte: start, lt: end },
      ...excludeId(check, "expense"),
    },
    orderBy: { date: "asc" },
    select: EXPENSE_REF_SELECT,
  });
  const expense = expenses.find((e) => expensePayableCents(e) === total);
  return expense ? { code: "possible_duplicate", existing: expenseRef(expense) } : null;
}

/**
 * Dentro de la transacción del alta, DESPUÉS de escribir el documento:
 * toma el candado del número y, si choca con otro, lanza
 * `DuplicateDocumentError` (la ruta deshace todo y responde 409).
 */
export async function assertNotDuplicateDocument(tx: Client, check: SupplierDocumentCheck): Promise<void> {
  const numberKey = normalizeDocumentNumber(check.number);
  if (!numberKey && check.possibleDuplicate !== "check") return;
  await lockSupplierDocument(tx, check.restaurantId, check.number);
  const finding = await findDuplicateDocument(tx, check);
  if (finding) throw new DuplicateDocumentError(finding.code, finding.existing);
}

/** Total a pagar de una compra recién escrita (para la advertencia sin número). */
export async function purchaseCheckAmounts(
  tx: Client,
  purchaseOrderId: string,
): Promise<{ date: Date; totalCents: number }> {
  const po = await tx.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    select: PURCHASE_REF_SELECT,
  });
  return { date: po.createdAt, totalCents: purchaseTotals(po).shown };
}

/**
 * `assertNotDuplicateDocument` para una compra recién escrita en `tx`: el
 * total y la fecha (para la advertencia sin número) salen de la compra
 * guardada, igual que los muestra la lista.
 */
export async function assertNotDuplicatePurchase(
  tx: Client,
  args: {
    restaurantId: string;
    purchaseOrderId: string;
    supplierId: string;
    number: string | null | undefined;
    possibleDuplicate?: PossibleDuplicateMode;
  },
): Promise<void> {
  const soft = !normalizeDocumentNumber(args.number) && args.possibleDuplicate === "check";
  await assertNotDuplicateDocument(tx, {
    restaurantId: args.restaurantId,
    supplierId: args.supplierId,
    number: args.number,
    exclude: { kind: "purchase", id: args.purchaseOrderId },
    possibleDuplicate: args.possibleDuplicate,
    ...(soft ? await purchaseCheckAmounts(tx, args.purchaseOrderId) : {}),
  });
}
