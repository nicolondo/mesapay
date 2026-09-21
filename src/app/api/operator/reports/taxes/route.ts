import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { baseReportQuery, periodFromQuery, searchParamsToObject } from "@/lib/erp/reports/params";
import { currentMonthPeriod, todayIso } from "@/lib/erp/reports/period";
import { loadTaxesReport } from "@/lib/erp/reports/taxesReport";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Impuestos del período: `?desde&hasta` (sin fechas: el mes en curso).
 * JSON `{ period, documental, book, cross, stats }`:
 *  · `documental`: IVA/INC generado en ventas por tarifa, IVA registrado en
 *    compras por tarifa, retenciones practicadas por concepto, totales y
 *    diferencia documental de IVA (`taxesDocuments.ts`);
 *  · `book`: movimiento del libro por familia de cuentas tributarias, en
 *    dos grupos (por pagar / a favor) con subtotales (`taxesModel.ts`);
 *  · `cross`: referencia documental vs movimiento del libro por familia;
 *  · `stats`: impuestos generados, IVA generado, INC generado (centavos).
 * Sin CSV: como en zenith, esta pantalla se imprime; el CSV vive en
 * `taxes-detail`.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = baseReportQuery
    .omit({ format: true })
    .safeParse(searchParamsToObject(new URL(req.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const q = parsed.data;
  const today = todayIso();
  const period = periodFromQuery(q.desde || q.hasta || q.anio ? q : currentMonthPeriod(today), today);
  if (!period) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const report = await loadTaxesReport(ctx.restaurantId, period);
  return NextResponse.json({
    period: { desde: period.desde, hasta: period.hasta },
    documental: report.documental,
    book: report.book,
    cross: report.cross,
    stats: report.stats,
  });
}

export const GET = secureApi(GETHandler);
