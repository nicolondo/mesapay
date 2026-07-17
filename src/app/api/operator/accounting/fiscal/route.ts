import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { monthRange } from "@/lib/erp/accounting";
import {
  generateYearClosing,
  loadClosing,
  loadTaxDeclaration,
} from "@/lib/erp/fiscal";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** Posición fiscal del mes (impuestos) + estado del cierre del año. */
export async function GET(req: Request) {
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
  const year = month.slice(0, 4);
  const [tax, closing] = await Promise.all([
    loadTaxDeclaration(ctx.restaurantId, range),
    loadClosing(ctx.restaurantId, year),
  ]);
  return NextResponse.json({ month, year, tax, closing });
}

/** Genera (o refresca) el asiento de cierre del año `year`. */
export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const year = searchParams.get("year") ?? "";
  if (!/^\d{4}$/.test(year)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const closing = await generateYearClosing(ctx.restaurantId, year);
  return NextResponse.json({ year, closing });
}
