import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { monthRange } from "@/lib/erp/accounting";
import { loadPurchasesBook, loadSalesBook } from "@/lib/erp/accountingData";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** Libros del mes (spec B2 · D5): ventas (órdenes pagadas) o compras (OCs recibidas). */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const book = searchParams.get("book");
  const range = monthRange(searchParams.get("month") ?? "");
  if (!range || (book !== "sales" && book !== "purchases")) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  if (book === "sales") {
    const { orders, totals } = await loadSalesBook(ctx.restaurantId, range);
    return NextResponse.json({ book, orders, totals });
  }
  const { rows, totals } = await loadPurchasesBook(ctx.restaurantId, range);
  return NextResponse.json({ book, rows, totals });
}
