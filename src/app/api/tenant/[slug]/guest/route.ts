import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { grantGuestAccess } from "@/lib/guestAccess";
import { redirectTo } from "@/lib/http/redirect";

/**
 * Primer escaneo del QR de la mesa: `/t/<slug>/menu` no encuentra la cookie
 * de invitado y manda acá; se pone la cookie y se vuelve al menú.
 *
 * La vuelta va con `Location` relativo. Antes se armaba con
 * `new URL(path, req.url)` y, detrás de nginx, `req.url` trae el host
 * interno: el primer escaneo terminaba en `https://localhost:3301/...`
 * (el segundo ya tenía la cookie y entraba directo).
 */
async function GETHandler(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const url = new URL(req.url);
  const token = url.searchParams.get("table");
  if (!token) return NextResponse.json({ error: "invalid_table" }, { status: 400 });
  const table = await db.table.findFirst({ where: { qrToken: token, restaurant: { slug }, number: { gte: 0 } } });
  if (!table) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await grantGuestAccess({ restaurantId: table.restaurantId, tableId: table.id });
  const query = new URLSearchParams({ table: token });
  for (const key of ["order", "op"]) { const value = url.searchParams.get(key); if (value) query.set(key, value); }
  return redirectTo(`/t/${encodeURIComponent(slug)}/menu?${query}`);
}

export const GET = secureApi(GETHandler);
