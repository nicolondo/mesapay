/**
 * Rótulos del informe de proveedores que comparten la pantalla y la
 * exportación (sin ExcelJS: la página no debe cargarlo). Lógica pura.
 */
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import type { SupplierReportPeriod } from "./supplierReport";

export type Tr = (key: string, values?: Record<string, string | number>) => string;

/** «nov 2025» de un `yyyy-mm`, en UTC (los meses del período son UTC). */
export function monthLabel(month: string, locale: Locale): string {
  return formatDate(new Date(`${month}-01T00:00:00Z`), {
    locale,
    timeZone: "UTC",
    dateStyle: undefined,
    timeStyle: undefined,
    month: "short",
    year: "numeric",
  });
}

/** «nov 2025 – oct 2026» (o el mes solo). */
export function periodLabel(period: Pick<SupplierReportPeriod, "fromMonth" | "toMonth">, locale: Locale): string {
  const from = monthLabel(period.fromMonth, locale);
  return period.fromMonth === period.toMonth ? from : `${from} – ${monthLabel(period.toMonth, locale)}`;
}

/** «Contado» o «Crédito 30 días» (namespace `opSupplierReport`). */
export function conditionLabel(t: Tr, creditDays: number | null): string {
  return creditDays === null ? t("cash") : t("credit", { days: creditDays });
}
