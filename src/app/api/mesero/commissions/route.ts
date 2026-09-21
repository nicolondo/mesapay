import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { commissionPeriodFromQuery, commissionsQuery, searchParamsToObject } from "@/lib/erp/reports/params";
import { loadSealedCommissions } from "@/lib/erp/reports/waiterCommissionQueries";
import { buildCommissionReport } from "@/lib/waiterCommissions";

export const dynamic = "force-dynamic";

/**
 * «Mis comisiones»: lo sellado a nombre del mesero de la sesión en el
 * período (`?desde&hasta`, default mes en curso, por FECHA DE PAGO). Misma
 * fuente y mismo modelo que el reporte del operador, filtrado a la persona
 * — como zenith `/mis-comisiones`. Sólo el rol mesero: el operador tiene el
 * reporte completo en /operator/reportes/comisiones.
 */
async function GETHandler(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "mesero") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = session.user.restaurantId;
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const parsed = commissionsQuery.safeParse(searchParamsToObject(new URL(req.url).searchParams));
  const period = parsed.success ? commissionPeriodFromQuery(parsed.data) : null;
  if (!period) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const rows = await loadSealedCommissions(restaurantId, period, { waiterId: session.user.id });
  const report = buildCommissionReport(rows);
  return NextResponse.json({
    period,
    summary: report.summary[0] ?? null,
    detail: report.detail,
    totals: report.totals,
  });
}

export const GET = secureApi(GETHandler);
