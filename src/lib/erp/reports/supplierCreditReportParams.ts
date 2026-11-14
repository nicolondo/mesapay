// Parámetros del reporte «Notas crédito de proveedores» (página y ruta API):
// `?desde&hasta&proveedor&tipo` — sin fechas, el mes en curso.
import { isSupplierCreditNoteKind, type SupplierCreditNoteKind } from "../supplierCreditNotes";
import { commissionPeriodFromQuery } from "./params";
import { currentMonthPeriod, isIsoDate, todayIso, type ReportPeriod } from "./period";

export type SupplierCreditReportQuery = {
  period: ReportPeriod;
  supplierId: string | null;
  kind: SupplierCreditNoteKind | null;
};

export function parseSupplierCreditReportQuery(
  q: Record<string, string | undefined>,
  today: string = todayIso(),
): SupplierCreditReportQuery {
  const desde = q.desde && isIsoDate(q.desde) ? q.desde : undefined;
  const hasta = q.hasta && isIsoDate(q.hasta) ? q.hasta : undefined;
  const period = commissionPeriodFromQuery({ desde, hasta }, today) ?? currentMonthPeriod(today);
  const supplierId = q.proveedor && /^[a-z0-9]{10,40}$/i.test(q.proveedor) ? q.proveedor : null;
  const kind = isSupplierCreditNoteKind(q.tipo) ? q.tipo : null;
  return { period, supplierId, kind };
}

export const SUPPLIER_CREDIT_REPORT_PATH = "/operator/reportes/notas-credito-proveedores";
export const SUPPLIER_CREDIT_REPORT_API = "/api/operator/reports/notas-credito-proveedores";

export function supplierCreditReportQs(q: SupplierCreditReportQuery, extra: Record<string, string> = {}): string {
  const sp = new URLSearchParams({ desde: q.period.desde, hasta: q.period.hasta, ...extra });
  if (q.supplierId) sp.set("proveedor", q.supplierId);
  if (q.kind) sp.set("tipo", q.kind);
  return `?${sp.toString()}`;
}
