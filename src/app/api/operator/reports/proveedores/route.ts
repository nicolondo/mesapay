import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";
import { defaultLocale, isLocale } from "@/i18n/config";
import { db } from "@/lib/db";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { csvResponse } from "@/lib/erp/reports/csv";
import { searchParamsToObject } from "@/lib/erp/reports/params";
import { todayIso } from "@/lib/erp/reports/period";
import {
  applySupplierReportView,
  paginateSupplierRows,
  parseSupplierReportQuery,
  supplierReportTotals,
} from "@/lib/erp/reports/supplierReport";
import {
  supplierReportCsv,
  supplierReportFilename,
  supplierReportXlsx,
} from "@/lib/erp/reports/supplierReportExport";
import { loadSupplierReportRows } from "@/lib/erp/reports/supplierReportQueries";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Abre con Compras O con Contabilidad: mismo criterio que la pantalla. */
const GATE: ModuleSlug[] = ["purchasing", "accounting"];

/**
 * Informe de proveedores con los MISMOS parámetros de la pantalla
 * (`?periodo&desde&hasta&base&gastos&q&condicion&orden&dir&pagina`):
 *
 *  · sin `format`: JSON con la página pedida, los totales de lo filtrado y
 *    el período resuelto;
 *  · `format=xlsx` / `format=csv`: TODAS las filas filtradas y ordenadas
 *    (sin paginar), ver `supplierReportExport.ts`.
 *
 * Sólo administración del comercio (`getErpContext`: operador, admin de
 * grupo o de plataforma); el mesero recibe 401, como en Compras y Reportes.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const sp = new URL(req.url).searchParams;
  const format = sp.get("format");
  if (format !== null && format !== "csv" && format !== "xlsx") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }
  const today = todayIso();
  const query = parseSupplierReportQuery(searchParamsToObject(sp), today);
  const all = await loadSupplierReportRows(ctx.restaurantId, query, today);
  const rows = applySupplierReportView(all, query);
  const totals = supplierReportTotals(rows, query.period.months);

  if (format === null) {
    return NextResponse.json({
      period: query.period,
      basis: query.basis,
      includeExpenses: query.includeExpenses,
      totals,
      ...paginateSupplierRows(rows, query.page),
    });
  }

  const [t, localeValue, tenant, currency] = await Promise.all([
    getTranslations("opSupplierReport"),
    getLocale(),
    db.restaurant.findUnique({
      where: { id: ctx.restaurantId },
      select: { name: true, legalName: true, taxId: true },
    }),
    getCurrencyForCountry(ctx.country),
  ]);
  const exportCtx = {
    t,
    locale: isLocale(localeValue) ? localeValue : defaultLocale,
    currency,
    business: { name: tenant?.legalName ?? tenant?.name ?? "", taxId: tenant?.taxId ?? null },
    query,
  };

  if (format === "csv") {
    return csvResponse(supplierReportFilename(query.period, "csv"), supplierReportCsv(rows, totals, exportCtx));
  }
  const body = await supplierReportXlsx(rows, totals, exportCtx);
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename="${supplierReportFilename(query.period, "xlsx")}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const GET = secureApi(GETHandler);
