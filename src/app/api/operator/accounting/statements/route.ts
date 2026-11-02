import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { monthRange } from "@/lib/erp/accounting";
import { loadStatements } from "@/lib/erp/reports";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Estados contables del mes derivados del Libro Diario: balance de
 * comprobación, estado de resultados y estado de situación financiera.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? "";
  // Mes UTC a propósito: los estados salen de los ASIENTOS, que ya van
  // fechados por día de negocio dentro de su día calendario UTC (los
  // diarios a la medianoche de Bogotá, los mensuales al fin de mes), así
  // que el mes UTC del libro ES el mes de negocio.
  const range = monthRange(month);
  if (!range) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const statements = await loadStatements(ctx.restaurantId, range);
  return NextResponse.json({ month, statements });
}

export const GET = secureApi(GETHandler);
