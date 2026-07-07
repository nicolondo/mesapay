import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { monthRange } from "@/lib/erp/accounting";
import { computeMonthPnl } from "@/lib/erp/accountingData";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** P&L del mes (spec B2 · D3) — derivado en vivo, nada persistido. */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? "";
  const range = monthRange(month);
  if (!range) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const pnl = await computeMonthPnl(ctx.restaurantId, range);
  return NextResponse.json({ month, pnl });
}
