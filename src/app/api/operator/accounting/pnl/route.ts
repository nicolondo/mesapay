import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { accountingMonthRange, computeMonthPnl, computeTaxSummary } from "@/lib/erp/accountingData";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * P&L del mes (spec B2 · D3) — derivado en vivo, nada persistido. El mes
 * es el de NEGOCIO del comercio (`accountingMonthRange`): los cobros,
 * compras, movimientos de inventario y reembolsos cortan por su día de
 * negocio, como los asientos del libro; gastos y turnos (FECHAS) siguen con
 * el mes calendario.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? "";
  const range = await accountingMonthRange(ctx.restaurantId, month);
  if (!range) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const [pnl, taxSummary] = await Promise.all([
    computeMonthPnl(ctx.restaurantId, range),
    computeTaxSummary(ctx.restaurantId, range),
  ]);
  return NextResponse.json({ month, pnl, taxSummary });
}

export const GET = secureApi(GETHandler);
