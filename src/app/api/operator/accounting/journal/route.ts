import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { monthRange } from "@/lib/erp/accounting";
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
  const entries = await loadJournalForMonth(ctx.restaurantId, month);
  return NextResponse.json({ month, entries });
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
  const results = await generateJournalForMonth(ctx.restaurantId, month, range);
  const entries = await loadJournalForMonth(ctx.restaurantId, month);
  return NextResponse.json({ month, results, entries });
}
