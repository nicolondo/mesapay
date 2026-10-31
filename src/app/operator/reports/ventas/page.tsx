import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { defaultLocale, isLocale } from "@/i18n/config";
import { bogotaBusinessTodayIso } from "@/lib/bogota";
import { asSalesTaxKind } from "@/lib/checkoutTax";
import { isModuleEnabled } from "@/lib/modules";
import { parseSalesFilters } from "@/lib/salesAnalysis/filters";
import { loadSalesAnalysis } from "@/lib/salesAnalysis/load";
import { SalesAnalysisView } from "./_components/SalesAnalysisView";

export const dynamic = "force-dynamic";

/**
 * Análisis de ventas: KPIs con comparación, tendencia, mapa de calor,
 * productos, equipo, pagos y canales, con drill-down en todo. Sólo para
 * la administración del comercio (operator, group_admin, platform_admin):
 * el mesero no entra (`getErpContext`, además del layout del panel).
 * Todo el estado vive en la URL (`@/lib/salesAnalysis/filters`).
 */
export default async function SalesAnalysisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [t, localeValue, ctx, query] = await Promise.all([
    getTranslations("salesAnalysis"),
    getLocale(),
    getErpContext([]),
    searchParams,
  ]);
  if (isDenied(ctx)) {
    return <div className="mp-page" role="alert">{t("noAccess")}</div>;
  }
  const tenant = await db.restaurant.findUnique({
    where: { id: ctx.restaurantId },
    select: {
      name: true,
      businessDayCutoffHour: true,
      salesTaxKind: true,
      salesTaxPct: true,
      serviceMode: true,
      enabledModules: true,
    },
  });
  if (!tenant) return <div className="mp-page" role="alert">{t("noAccess")}</div>;

  const locale = isLocale(localeValue) ? localeValue : defaultLocale;
  const filters = parseSalesFilters(query);
  const cutoffHour = tenant.businessDayCutoffHour;
  const today = bogotaBusinessTodayIso(cutoffHour);
  const counterMode = tenant.serviceMode === "counter";
  const kind = asSalesTaxKind(tenant.salesTaxKind);
  const [analysis, currency] = await Promise.all([
    loadSalesAnalysis(db, {
      restaurantId: ctx.restaurantId,
      filters,
      today,
      cutoffHour,
      tax: { kind, pct: kind === "none" ? 0 : tenant.salesTaxPct },
      counterMode,
      recipesEnabled: isModuleEnabled(tenant.enabledModules, "recipes"),
    }),
    getCurrencyForCountry(ctx.country),
  ]);

  return <SalesAnalysisView t={t} analysis={analysis} locale={locale} currency={currency} tenantName={tenant.name} />;
}
