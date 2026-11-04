import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";
import { z } from "zod";
import { defaultLocale, isLocale } from "@/i18n/config";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { auxTotals } from "@/lib/erp/reports/auxRows";
import { csvResponse } from "@/lib/erp/reports/csv";
import { isDrillId } from "@/lib/erp/reports/drillState";
import { baseReportQuery, periodFromQuery, searchParamsToObject } from "@/lib/erp/reports/params";
import { currentMonthPeriod, todayIso } from "@/lib/erp/reports/period";
import { paginate } from "@/lib/erp/reports/taxesDrill";
import { allTaxesSections, auxRowsSection } from "@/lib/erp/reports/taxesExport";
import { makeTaxesExportLabels } from "@/lib/erp/reports/taxesLabels";
import { auxRowsForNode, loadTaxesDrillBase, taxChecks } from "@/lib/erp/reports/taxesDrillReport";
import { sectionsToCsv, sectionsToXlsx } from "@/lib/salesAnalysis/export";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const ALL = "todo";

const query = baseReportQuery.omit({ format: true }).extend({
  nodo: z.string().refine((v) => v === ALL || isDrillId(v)),
  page: z.coerce.number().int().min(1).max(100_000).optional(),
  size: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  format: z.enum(["csv", "xlsx"]).optional(),
});

/**
 * AUXILIARES de «Impuestos del período» (nivel 3 del despliegue y filas de
 * las revisiones): `?desde&hasta&nodo=<id>[&page&size][&format=csv|xlsx]`.
 * Mismo período y misma foto de datos que la página (`loadTaxesDrillBase`
 * con caché de 60 s), así las filas suman exactamente el renglón que se
 * abrió.
 *
 *  · `nodo`: un renglón de nivel 2 (`inc-ventas-8`, `iva-libro-sale`),
 *    uno de «otros» (`otros-retefuente-favor`) o una revisión
 *    (`alerta-sinFactura`). `todo` sólo con `format` (todo el despliegue).
 *  · JSON paginado: `{ period, node, kind, page, pages, size, total,
 *    totals: { count, amountCents, baseCents }, rows }` — `totals` es sobre
 *    TODAS las filas, no sólo la página.
 *  · CSV / Excel: todas las filas del renglón (o todo el despliegue).
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = query.safeParse(searchParamsToObject(new URL(req.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const q = parsed.data;
  if (q.nodo === ALL && !q.format) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const today = todayIso();
  const period = periodFromQuery(q.desde || q.hasta || q.anio ? q : currentMonthPeriod(today), today);
  if (!period) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const base = await loadTaxesDrillBase(ctx.restaurantId, { desde: period.desde, hasta: period.hasta }, { useCache: true });

  const node = q.nodo === ALL ? null : auxRowsForNode(base, q.nodo);
  if (q.nodo !== ALL && !node) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (q.format) {
    const [t, tDrill, tErp, localeValue, currency] = await Promise.all([
      getTranslations("opImpuestosRep"),
      getTranslations("opReportDrill"),
      getTranslations("opErp"),
      getLocale(),
      getCurrencyForCountry(ctx.country),
    ]);
    const locale = isLocale(localeValue) ? localeValue : defaultLocale;
    const labels = makeTaxesExportLabels(t, tDrill, tErp, locale);
    const sections = node
      ? [auxRowsSection(t("xlsxAux"), node.rows, labels)]
      : allTaxesSections(base.drill, base.facts, taxChecks(base), labels);
    const stem = `impuestos-auxiliares-${period.desde}-a-${period.hasta}${node ? `-${q.nodo}` : ""}`;
    if (q.format === "csv") return csvResponse(`${stem}.csv`, sectionsToCsv(sections));
    const body = await sectionsToXlsx(sections, currency);
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": XLSX_TYPE,
        "Content-Disposition": `attachment; filename="${stem}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const size = q.size ?? DEFAULT_PAGE_SIZE;
  const page = paginate(node!.rows, q.page ?? 1, size);
  return NextResponse.json({
    period: { desde: period.desde, hasta: period.hasta },
    node: q.nodo,
    kind: node!.kind,
    page: page.page,
    pages: page.pages,
    size,
    total: node!.rows.length,
    totals: auxTotals(node!.rows),
    rows: page.rows,
  });
}

export const GET = secureApi(GETHandler);
