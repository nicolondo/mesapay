import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { csvResponse } from "@/lib/erp/reports/csv";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { defaultLocale, isLocale } from "@/i18n/config";
import { bogotaBusinessTodayIso } from "@/lib/bogota";
import { asSalesTaxKind } from "@/lib/checkoutTax";
import { isModuleEnabled } from "@/lib/modules";
import { parseSalesFilters } from "@/lib/salesAnalysis/filters";
import { loadSalesAnalysis } from "@/lib/salesAnalysis/load";
import { buildExportSections, exportFilename, sectionsToCsv, sectionsToXlsx } from "@/lib/salesAnalysis/export";

export const dynamic = "force-dynamic";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Exporta la VISTA ACTUAL del análisis de ventas (mismos filtros de la URL
 * de la pantalla): `?formato=csv|xlsx&periodo=…&mesero=…`. Sólo
 * administración del comercio (el mesero recibe 401, como en la pantalla).
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext([]);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const url = new URL(req.url);
  const format = url.searchParams.get("formato");
  if (format !== "csv" && format !== "xlsx") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }
  const tenant = await db.restaurant.findUnique({
    where: { id: ctx.restaurantId },
    select: { name: true, businessDayCutoffHour: true, salesTaxKind: true, salesTaxPct: true, serviceMode: true, enabledModules: true },
  });
  if (!tenant) return NextResponse.json({ error: "no_restaurant" }, { status: 400 });

  const [t, localeValue, currency] = await Promise.all([
    getTranslations("salesAnalysis"),
    getLocale(),
    getCurrencyForCountry(ctx.country),
  ]);
  const locale = isLocale(localeValue) ? localeValue : defaultLocale;
  const kind = asSalesTaxKind(tenant.salesTaxKind);
  const counterMode = tenant.serviceMode === "counter";
  const analysis = await loadSalesAnalysis(db, {
    restaurantId: ctx.restaurantId,
    filters: parseSalesFilters(url.searchParams),
    today: bogotaBusinessTodayIso(tenant.businessDayCutoffHour),
    cutoffHour: tenant.businessDayCutoffHour,
    tax: { kind, pct: kind === "none" ? 0 : tenant.salesTaxPct },
    counterMode,
    recipesEnabled: isModuleEnabled(tenant.enabledModules, "recipes"),
  });
  const sections = buildExportSections(analysis, { t, locale, counterMode, restaurantName: tenant.name });

  if (format === "csv") return csvResponse(exportFilename(analysis, "csv"), sectionsToCsv(sections));
  const body = await sectionsToXlsx(sections, currency);
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename="${exportFilename(analysis, "xlsx")}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const GET = secureApi(GETHandler);
