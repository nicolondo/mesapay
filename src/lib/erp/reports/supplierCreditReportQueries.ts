/**
 * Capa de DATOS del reporte «Notas crédito de proveedores» (la única que
 * toca Prisma). Notas vigentes del comercio con FECHA en el período; con
 * `supplierId`/`kind`, sólo esas.
 */
import { db } from "@/lib/db";
import { isSupplierCreditNoteKind, type SupplierCreditNoteKind } from "../supplierCreditNotes";
import { periodToUtcRange, isoDateUtc, type ReportPeriod } from "./period";
import { buildSupplierCreditReport, type SupplierCreditReport, type SupplierCreditReportRow } from "./supplierCreditReport";

export type SupplierCreditReportFilters = { supplierId?: string | null; kind?: SupplierCreditNoteKind | null };

export async function loadSupplierCreditReport(
  restaurantId: string,
  period: ReportPeriod,
  filters: SupplierCreditReportFilters = {},
): Promise<SupplierCreditReport> {
  const { from, to } = periodToUtcRange(period);
  const notes = await db.supplierCreditNote.findMany({
    where: {
      restaurantId,
      status: "active",
      date: { gte: from, lt: to },
      ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
    },
    select: {
      id: true,
      number: true,
      date: true,
      kind: true,
      agreement: true,
      totalCents: true,
      ivaCents: true,
      incCents: true,
      supplier: { select: { id: true, name: true, taxId: true } },
    },
  });
  const rows: SupplierCreditReportRow[] = [];
  for (const n of notes) {
    if (!isSupplierCreditNoteKind(n.kind)) continue;
    rows.push({
      id: n.id,
      number: n.number,
      date: isoDateUtc(n.date),
      kind: n.kind,
      agreement: n.agreement,
      supplierId: n.supplier.id,
      supplierName: n.supplier.name,
      supplierTaxId: n.supplier.taxId,
      totalCents: n.totalCents,
      baseCents: n.totalCents - n.ivaCents - n.incCents,
      ivaCents: n.ivaCents,
      incCents: n.incCents,
    });
  }
  return buildSupplierCreditReport(rows);
}

/** Proveedores con notas (para el filtro del reporte). */
export async function loadCreditNoteSuppliers(restaurantId: string) {
  return db.supplier.findMany({
    where: { restaurantId, creditNotes: { some: {} } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, taxId: true },
  });
}
