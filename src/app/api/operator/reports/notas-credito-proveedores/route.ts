import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { csvResponse } from "@/lib/erp/reports/csv";
import { searchParamsToObject } from "@/lib/erp/reports/params";
import { loadSupplierCreditReport } from "@/lib/erp/reports/supplierCreditReportQueries";
import { parseSupplierCreditReportQuery } from "@/lib/erp/reports/supplierCreditReportParams";
import {
  supplierCreditCsv,
  supplierCreditFilename,
  supplierCreditXlsx,
} from "@/lib/erp/reports/supplierCreditReportExport";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** Abre con Compras O con Contabilidad. */
const GATE: ModuleSlug[] = ["purchasing", "accounting"];

/**
 * Notas crédito de proveedores del período (`?desde&hasta&proveedor&tipo`):
 * sin `format`, JSON con los totales por tipo, proveedor, acuerdo y mes;
 * `format=xlsx|csv`, la descarga.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const sp = new URL(req.url).searchParams;
  const format = sp.get("format");
  if (format !== null && format !== "csv" && format !== "xlsx") {
    return NextResponse.json({ error: "invalid_format" }, { status: 400 });
  }
  const query = parseSupplierCreditReportQuery(searchParamsToObject(sp));
  const report = await loadSupplierCreditReport(ctx.restaurantId, query.period, query);
  if (format === null) return NextResponse.json({ period: query.period, ...report });

  const [t, tenant, currency] = await Promise.all([
    getTranslations("opSupplierCredit"),
    db.restaurant.findUnique({ where: { id: ctx.restaurantId }, select: { name: true, legalName: true, taxId: true } }),
    getCurrencyForCountry(ctx.country),
  ]);
  const exportCtx = {
    t: t as unknown as (key: string, values?: Record<string, string | number>) => string,
    currency,
    business: { name: tenant?.legalName ?? tenant?.name ?? "", taxId: tenant?.taxId ?? null },
    period: query.period,
  };
  if (format === "csv") {
    return csvResponse(supplierCreditFilename(query.period, "csv"), supplierCreditCsv(report, exportCtx));
  }
  const body = await supplierCreditXlsx(report, exportCtx);
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": XLSX_TYPE,
      "Content-Disposition": `attachment; filename="${supplierCreditFilename(query.period, "xlsx")}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const GET = secureApi(GETHandler);
