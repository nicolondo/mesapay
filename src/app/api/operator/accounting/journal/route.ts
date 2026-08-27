import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { monthRange } from "@/lib/erp/accounting";
import { getAccountingConfig, isMonthClosed } from "@/lib/erp/cierre";
import {
  generateJournalForMonth,
  loadJournalForMonth,
} from "@/lib/erp/posting";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** Libro Diario del mes: asientos-resumen ya generados. */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? "";
  if (!monthRange(month)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const [entries, cfg] = await Promise.all([
    loadJournalForMonth(ctx.restaurantId, month),
    getAccountingConfig(ctx.restaurantId),
  ]);
  return NextResponse.json({
    month,
    entries,
    closedThrough: cfg.closedThrough,
    monthClosed: isMonthClosed(cfg.closedThrough, month),
  });
}

/** Genera (o refresca) los asientos-resumen del mes a partir de la operación. */
export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? "";
  const range = monthRange(month);
  if (!range) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  // Candado de cierre: un mes cerrado tiene comprobantes numerados en firme
  // — no se regenera. Reabrir primero (Diario → Reabrir último mes).
  const cfg = await getAccountingConfig(ctx.restaurantId);
  if (isMonthClosed(cfg.closedThrough, month)) {
    return NextResponse.json(
      { error: "month_closed", closedThrough: cfg.closedThrough },
      { status: 409 },
    );
  }
  const results = await generateJournalForMonth(ctx.restaurantId, month, range);
  const entries = await loadJournalForMonth(ctx.restaurantId, month);
  return NextResponse.json({ month, results, entries });
}
