/**
 * Reporte «Notas crédito de proveedores» — LÓGICA PURA. Cuánto se recibió de
 * los proveedores en el período, por tipo (acuerdo comercial, descuento,
 * pronto pago, devolución), por proveedor, por acuerdo y por mes.
 *
 * Cuenta las notas VIGENTES por su fecha (la contable). Una nota anulada no
 * se recibió: no entra (el libro la netea con su reverso). «Recibido» es el
 * valor total de la nota; la base (sin IVA ni INC) y el IVA van aparte para
 * cuadrar con el libro (la base más el impuesto que es costo va a la cuenta
 * del tipo, el IVA descontable a 2408).
 */
import { SUPPLIER_CREDIT_NOTE_KINDS, type SupplierCreditNoteKind } from "../supplierCreditNotes";

export type SupplierCreditReportRow = {
  id: string;
  number: string;
  /** yyyy-mm-dd */
  date: string;
  kind: SupplierCreditNoteKind;
  agreement: string | null;
  supplierId: string;
  supplierName: string;
  supplierTaxId: string | null;
  totalCents: number;
  baseCents: number;
  ivaCents: number;
  incCents: number;
};

export type KindTotals = Record<SupplierCreditNoteKind, number>;

export type SupplierCreditReport = {
  totals: { count: number; totalCents: number; baseCents: number; ivaCents: number; incCents: number };
  byKind: Array<{ kind: SupplierCreditNoteKind; count: number; totalCents: number; baseCents: number; ivaCents: number }>;
  bySupplier: Array<{
    supplierId: string;
    name: string;
    taxId: string | null;
    count: number;
    totalCents: number;
    byKind: KindTotals;
  }>;
  /** Sólo acuerdos comerciales, agrupados por proveedor + concepto (sin concepto = null). */
  byAgreement: Array<{ key: string; supplierId: string; supplierName: string; agreement: string | null; count: number; totalCents: number; baseCents: number }>;
  byMonth: Array<{ month: string; totalCents: number; byKind: KindTotals }>;
  rows: SupplierCreditReportRow[];
};

export function emptyKindTotals(): KindTotals {
  return Object.fromEntries(SUPPLIER_CREDIT_NOTE_KINDS.map((k) => [k, 0])) as KindTotals;
}

/** Clave de agrupación de un acuerdo: sin mayúsculas, tildes ni espacios repetidos. */
export function agreementKey(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSupplierCreditReport(rows: readonly SupplierCreditReportRow[]): SupplierCreditReport {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
  const totals = { count: 0, totalCents: 0, baseCents: 0, ivaCents: 0, incCents: 0 };
  const kind = new Map<SupplierCreditNoteKind, SupplierCreditReport["byKind"][number]>();
  const supplier = new Map<string, SupplierCreditReport["bySupplier"][number]>();
  const agreement = new Map<string, SupplierCreditReport["byAgreement"][number]>();
  const month = new Map<string, SupplierCreditReport["byMonth"][number]>();
  for (const r of sorted) {
    totals.count += 1;
    totals.totalCents += r.totalCents;
    totals.baseCents += r.baseCents;
    totals.ivaCents += r.ivaCents;
    totals.incCents += r.incCents;

    const k = kind.get(r.kind) ?? { kind: r.kind, count: 0, totalCents: 0, baseCents: 0, ivaCents: 0 };
    k.count += 1;
    k.totalCents += r.totalCents;
    k.baseCents += r.baseCents;
    k.ivaCents += r.ivaCents;
    kind.set(r.kind, k);

    const s = supplier.get(r.supplierId) ?? {
      supplierId: r.supplierId,
      name: r.supplierName,
      taxId: r.supplierTaxId,
      count: 0,
      totalCents: 0,
      byKind: emptyKindTotals(),
    };
    s.count += 1;
    s.totalCents += r.totalCents;
    s.byKind[r.kind] += r.totalCents;
    supplier.set(r.supplierId, s);

    if (r.kind === "agreement") {
      const key = `${r.supplierId}|${agreementKey(r.agreement)}`;
      const a = agreement.get(key) ?? {
        key,
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        agreement: r.agreement?.trim() || null,
        count: 0,
        totalCents: 0,
        baseCents: 0,
      };
      a.count += 1;
      a.totalCents += r.totalCents;
      a.baseCents += r.baseCents;
      agreement.set(key, a);
    }

    const mk = r.date.slice(0, 7);
    const m = month.get(mk) ?? { month: mk, totalCents: 0, byKind: emptyKindTotals() };
    m.totalCents += r.totalCents;
    m.byKind[r.kind] += r.totalCents;
    month.set(mk, m);
  }
  return {
    totals,
    byKind: SUPPLIER_CREDIT_NOTE_KINDS.map((k) => kind.get(k)).filter((x): x is NonNullable<typeof x> => !!x),
    bySupplier: [...supplier.values()].sort((a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name)),
    byAgreement: [...agreement.values()].sort(
      (a, b) => b.totalCents - a.totalCents || a.supplierName.localeCompare(b.supplierName),
    ),
    byMonth: [...month.values()].sort((a, b) => a.month.localeCompare(b.month)),
    rows: sorted,
  };
}

/**
 * Gancho para el informe de proveedores: por proveedor, lo recibido por
 * acuerdos comerciales y el total de notas del período.
 */
export function supplierCreditTotalsBySupplier(
  report: Pick<SupplierCreditReport, "bySupplier">,
): Map<string, { agreementCents: number; totalCents: number }> {
  return new Map(report.bySupplier.map((s) => [s.supplierId, { agreementCents: s.byKind.agreement, totalCents: s.totalCents }]));
}
