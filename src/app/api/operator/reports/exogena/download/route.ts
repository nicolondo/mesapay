import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { buildFormatoXml } from "@/lib/erp/exogena/download";
import { isFormatoExogena } from "@/lib/erp/exogena/normativa";
import { loadExogenaReport } from "@/lib/erp/exogena/queries";
import { toLatin1 } from "@/lib/erp/exogena/xml";
import { exogenaContext, isResponse, parseExogenaYear } from "../_shared";

export const dynamic = "force-dynamic";

/**
 * XML oficial DIAN de un formato: `?formato=1001&year=2025`. Responde
 * `application/xml; charset=ISO-8859-1` con el nombre `Dmuisca_…`. Con
 * incidencias bloqueantes en el formato: 422 `issues_pending` + la lista;
 * un formato sin XML (2276): 422 `no_xml`.
 */
async function GETHandler(req: Request) {
  const ctx = await exogenaContext();
  if (isResponse(ctx)) return ctx;
  const sp = new URL(req.url).searchParams;
  const formato = sp.get("formato") ?? "";
  const year = parseExogenaYear(sp.get("year"));
  if (year === null || !isFormatoExogena(formato)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const { uvtPesos, report } = await loadExogenaReport(ctx.restaurantId, year);
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
