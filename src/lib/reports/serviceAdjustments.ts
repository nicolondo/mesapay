import { z } from "zod";
import { addDaysIso, bogotaDayRange } from "@/lib/bogota";
import { isIsoDate } from "@/lib/erp/reports/period";

export type ServiceReport = "representation" | "uncollected";
export type ServiceReportView = "orders" | "items";
export type ServiceAdjustmentKind = "order_comp" | "item_comp" | "item_cancel" | "round_cancel";
export type ServiceReportFilters = {
  report: ServiceReport;
  view: ServiceReportView;
  range: string;
  desde: string | null;
  hasta: string | null;
  start: Date | null;
  end: Date | null;
  kind: "all" | "cancel" | "comp" | "representation";
  email: string | null;
  q: string | null;
  orderId: string | null;
  page: number;
  pageSize: number;
};
export type ServiceReportRow = {
  id: string;
  eventAt: Date;
  orderId: string;
  shortCode: string | null;
  tableNumber: number | null;
  tableLabel: string | null;
  name: string | null;
  kind: ServiceAdjustmentKind;
  reason: string | null;
  actorEmail: string | null;
  quantity: number;
  lineCount: number;
  amountCents: number | null;
  detailAmountCents: number;
  missingDetail: boolean;
};
export type ServiceReportTotals = {
  rowCount: number;
  orderCount: number;
  lineCount: number;
  quantity: number;
  amountCents: number;
  unknownAmountCount: number;
  cancelAmountCents: number;
  compAmountCents: number;
  representationAmountCents: number;
};
export type ServiceReportResult = {
  rows: ServiceReportRow[];
  totals: ServiceReportTotals;
  page: number;
  pageSize: number;
  pageCount: number;
};
export type ServiceReportSearch = Record<string, string | string[] | undefined>;

const date = z.string().refine(v => isIsoDate(v) && v >= "2000-01-01" && v <= "2999-12-31");
const querySchema = z.object({
  range: z.enum(["today", "7d", "30d", "month", "all", "custom"]).default("7d"),
  desde: date.optional(), hasta: date.optional(),
  kind: z.enum(["all", "cancel", "comp", "representation"]).default("all"),
  vista: z.enum(["cuentas", "productos"]).optional(),
  email: z.string().trim().max(254).optional(),
  q: z.string().trim().max(160).optional(),
  orderId: z.string().trim().max(128).optional(),
  page: z.string().regex(/^[1-9]\d{0,6}$/).transform(Number).refine(v => v <= 1_000_000).default(1),
  format: z.enum(["json", "csv"]).optional(),
});

export function parseServiceReportFilters(
  report: ServiceReport, query: ServiceReportSearch, cutoffHour: number, now = new Date(),
): ServiceReportFilters {
  const cleaned = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== "" && value !== undefined));
  const parsed = querySchema.safeParse(cleaned);
  if (!parsed.success) throw new Error("invalid_report_filters");
  const input = parsed.data;
  const cutoff = Number.isInteger(cutoffHour) && cutoffHour >= 0 && cutoffHour <= 23 ? cutoffHour : 0;
  const today = new Date(now.getTime() - (5 + cutoff) * 3_600_000).toISOString().slice(0, 10);
  const custom = Boolean(input.desde || input.hasta);
  if ((custom && (!input.desde || !input.hasta || input.desde > input.hasta)) || (input.range === "custom" && !custom)) {
    throw new Error("invalid_report_filters");
  }
  const range = custom ? "custom" : input.range;
  const desde = custom ? input.desde! : range === "all" ? null
    : range === "today" ? today : range === "month" ? `${today.slice(0, 7)}-01`
    : addDaysIso(today, range === "30d" ? -29 : -6);
  const hasta = custom ? input.hasta! : range === "all" ? null : today;
  return {
    report, view: report === "representation" && input.vista !== "productos" ? "orders" : "items",
    range, desde, hasta,
    start: desde ? bogotaDayRange(desde, cutoff).start : null,
    end: hasta ? bogotaDayRange(hasta, cutoff).end : null,
    kind: report === "representation" ? "representation" : input.kind,
    email: input.email || null, q: input.q || null, orderId: input.orderId || null,
    page: input.page, pageSize: 50,
  };
}

export function serviceReportPath(report: ServiceReport): string {
  return `/operator/reports/${report === "representation" ? "gastos-representacion" : "no-cobrados"}`;
}

/** Null explicitly clears a filter; undefined leaves it unchanged. */
export function serviceReportSearchParams(
  filters: ServiceReportFilters, patch: Partial<ServiceReportFilters> = {},
): URLSearchParams {
  const value = { ...filters, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
  const params = new URLSearchParams();
  if (value.range === "custom" && value.desde && value.hasta) {
    params.set("desde", value.desde); params.set("hasta", value.hasta);
  } else params.set("range", value.range);
  if (value.report === "representation" && value.view === "items") params.set("vista", "productos");
  if (value.report === "uncollected" && value.kind !== "all") params.set("kind", value.kind);
  if (value.email) params.set("email", value.email);
  if (value.q) params.set("q", value.q);
  if (value.orderId) params.set("orderId", value.orderId);
  if (value.page > 1) params.set("page", String(value.page));
  return params;
}

export function serviceReportHref(filters: ServiceReportFilters, patch: Partial<ServiceReportFilters> = {}): string {
  return `${serviceReportPath(patch.report ?? filters.report)}?${serviceReportSearchParams(filters, patch)}`;
}
