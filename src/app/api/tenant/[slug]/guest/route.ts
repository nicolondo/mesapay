import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { grantGuestAccess } from "@/lib/guestAccess";

async function GETHandler(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const url = new URL(req.url);
  const token = url.searchParams.get("table");
  if (!token) return NextResponse.json({ error: "invalid_table" }, { status: 400 });
  const table = await db.table.findFirst({ where: { qrToken: token, restaurant: { slug }, number: { gte: 0 } } });
  if (!table) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await grantGuestAccess({ restaurantId: table.restaurantId, tableId: table.id });
  const target = new URL(`/t/${slug}/menu`, req.url);
  target.searchParams.set("table", token);
  for (const key of ["order", "op"]) { const value = url.searchParams.get(key); if (value) target.searchParams.set(key, value); }
  return NextResponse.redirect(target);
}

export const GET = secureApi(GETHandler);
