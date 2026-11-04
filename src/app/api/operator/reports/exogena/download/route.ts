import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";
import { defaultLocale, isLocale } from "@/i18n/config";
import { db } from "@/lib/db";
import { buildFormatoXml } from "@/lib/erp/exogena/download";
import { buildFormatoXlsx } from "@/lib/erp/exogena/excel";
import { isFormatoExogena } from "@/lib/erp/exogena/normativa";
import { loadExogenaReport } from "@/lib/erp/exogena/queries";
import { toLatin1 } from "@/lib/erp/exogena/xml";
import { exogenaContext, isResponse, parseExogenaYear } from "../_shared";

export const dynamic = "force-dynamic";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Descarga de un formato: `?formato=1001&year=2025&type=xml|xlsx` (sin
 * `type` = XML, el enlace de siempre).
 *
 * · XML oficial DIAN: `application/xml; charset=ISO-8859-1` con el nombre
 *   `Dmuisca_…`. Con incidencias bloqueantes en el formato: 422
 *   `issues_pending` + la lista; un formato sin XML (2276): 422 `no_xml`.
 * · Excel de revisión (`type=xlsx`): los MISMOS registros del XML en
 *   columnas (ver `excel.ts`), con el nombre `Dmuisca_….xlsx`. Se descarga
 *   siempre: con incidencias bloqueantes trae la hoja de incidencias y las
 *   filas marcadas; el 2276 sale como hoja de trabajo.
 */
async function GETHandler(req: Request) {
  const ctx = await exogenaContext();
  if (isResponse(ctx)) return ctx;
  const sp = new URL(req.url).searchParams;
  const formato = sp.get("formato") ?? "";
  const year = parseExogenaYear(sp.get("year"));
  const type = sp.get("type") ?? "xml";
  if (year === null || !isFormatoExogena(formato) || (type !== "xml" && type !== "xlsx")) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const { uvtPesos, report } = await loadExogenaReport(ctx.restaurantId, year);

  if (type === "xlsx") {
    const [t, localeValue, tenant] = await Promise.all([
      getTranslations("opExogena"),
      getLocale(),
      db.restaurant.findUnique({
        where: { id: ctx.restaurantId },
        select: { name: true, legalName: true, taxId: true },
      }),
    ]);
    const built = await buildFormatoXlsx({
      report,
      formato,
      year,
      uvtPesos,
      informante: { name: tenant?.legalName ?? tenant?.name ?? "", taxId: tenant?.taxId ?? null },
      t,
      locale: isLocale(localeValue) ? localeValue : defaultLocale,
    });
    return new Response(new Uint8Array(built.body), {
      status: 200,
      headers: {
        "Content-Type": XLSX_TYPE,
        "Content-Disposition": `attachment; filename="${built.filename}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const built = buildFormatoXml(report, formato, year, uvtPesos);
  if (!built.ok) {
    return NextResponse.json(
      {
        error: built.error,
        issues: report.issues.filter((i) => i.format === formato && i.blocking),
      },
      { status: 422 },
    );
  }
  return new NextResponse(toLatin1(built.xml), {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=ISO-8859-1",
      "Content-Disposition": `attachment; filename="${built.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const GET = secureApi(GETHandler);
