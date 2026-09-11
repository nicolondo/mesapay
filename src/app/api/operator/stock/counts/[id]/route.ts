import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { stockCountInclude } from "@/lib/erp/stockCounts";
import { countMutation } from "../mutation";

export const dynamic = "force-dynamic";

async function GETHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(["inventory"]);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { id } = await params;
  const count = await db.stockCount.findFirst({ where: { id, restaurantId: ctx.restaurantId }, include: stockCountInclude });
  if (!count) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ count });
}

export const GET = secureApi(GETHandler);
export const PATCH = secureApi(countMutation("save"));
export const DELETE = secureApi(countMutation("delete"));
