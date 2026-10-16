import "server-only";
import { getLocale, getTranslations } from "next-intl/server";
import { defaultLocale, isLocale } from "@/i18n/config";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { rateLimit } from "@/lib/rateLimit";
import { secureApi } from "@/lib/secureApi";
import { parseServiceReportFilters, type ServiceReport, type ServiceReportFilters } from "./serviceAdjustments";
import { streamServiceReportCsv } from "./serviceAdjustmentsCsv";
import { getServiceReport, iterateServiceReportRows } from "./serviceAdjustmentsQuery";

const invalidFilters = () => Response.json({ error: "invalid_report_filters" }, { status: 400 });
const rateLimited = () => Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });

function uniqueSearchParams(params: URLSearchParams): Record<string, string> | null {
  for (const key of params.keys()) if (params.getAll(key).length !== 1) return null;
  return Object.fromEntries(params);
}

async function handleServiceReport(req: Request, report: ServiceReport): Promise<Response> {
  // These service reports are administrative, independent of ERP subscriptions.
  const ctx = await getErpContext([]);
  if (isDenied(ctx)) return Response.json({ error: ctx.error }, { status: ctx.status });
  const query = uniqueSearchParams(new URL(req.url).searchParams);
  if (!query) return invalidFilters();
  if (!await rateLimit(`service-reports:read:${ctx.restaurantId}:${ctx.userId ?? "unknown"}`, 120, 60)) return rateLimited();

  const restaurant = await db.restaurant.findUnique({
    where: { id: ctx.restaurantId }, select: { businessDayCutoffHour: true },
  });
  if (!restaurant) return Response.json({ error: "no_restaurant" }, { status: 400 });
  let filters: ServiceReportFilters;
  try {
    filters = parseServiceReportFilters(report, query, restaurant.businessDayCutoffHour);
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_report_filters") return invalidFilters();
    throw error;
  }

  if (query.format === "csv") {
    if (!await rateLimit(`service-reports:export:${ctx.restaurantId}`, 30, 60)) return rateLimited();
    const [currency, locale, t] = await Promise.all([
      getCurrencyForCountry(ctx.country), getLocale(), getTranslations("serviceReports"),
    ]);
    const name = report === "representation" ? "gastos-representacion" : "no-cobrados";
    const period = filters.desde && filters.hasta ? `${filters.desde}-${filters.hasta}` : "all";
    return streamServiceReportCsv({
      rows: iterateServiceReportRows(ctx.restaurantId, { ...filters, page: 1 }),
      filename: `${name}-${period}.csv`, currency, locale: isLocale(locale) ? locale : defaultLocale, t,
      signal: req.signal,
    });
  }

  const [result, currency] = await Promise.all([
    getServiceReport(ctx.restaurantId, filters), getCurrencyForCountry(ctx.country),
  ]);
  return Response.json({ ...result, currency, filters });
}

export function createServiceReportGet(report: ServiceReport): (req: Request) => Promise<Response> {
  const guarded = secureApi((req: Request) => handleServiceReport(req, report));
  return async (req) => {
    const response = await guarded(req);
    // Apply to authorization and failure responses as well as successful data.
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Vary", "Cookie, Accept-Language");
    return response;
  };
}
