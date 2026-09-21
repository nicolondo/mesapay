import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import {
  catalogoFormatos,
  resolucionesDelAno,
  umbralPagosCents,
  umbralSaldosCents,
} from "@/lib/erp/exogena/normativa";
import { loadExogenaReport } from "@/lib/erp/exogena/queries";
import { exogenaContext, isResponse, parseExogenaYear } from "./_shared";

export const dynamic = "force-dynamic";

/**
 * Información exógena del año gravable: `?year=` (default: año anterior).
 * `{ year, normativa, formats: { "1001": { rows, totalCents, issues }, … },
 * issues }` — lo mismo que renderiza la pantalla.
 */
async function GETHandler(req: Request) {
  const ctx = await exogenaContext();
  if (isResponse(ctx)) return ctx;
  const year = parseExogenaYear(new URL(req.url).searchParams.get("year"));
  if (year === null) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const { uvtPesos, report } = await loadExogenaReport(ctx.restaurantId, year);
  const formats = Object.fromEntries(
    catalogoFormatos(year).map((f) => [
      f.codigo,
      {
        ...f,
        rows: report.formats[f.codigo],
        totalCents: report.totals[f.codigo],
        issues: report.issues.filter((i) => i.format === f.codigo),
      },
    ]),
  );
  return NextResponse.json({
    year,
    normativa: {
      resoluciones: resolucionesDelAno(year),
      uvtPesos,
      cuantiaPagosCents: umbralPagosCents(uvtPesos),
      cuantiaSaldosCents: umbralSaldosCents(uvtPesos),
    },
    formats,
    issues: report.issues,
  });
}

export const GET = secureApi(GETHandler);
