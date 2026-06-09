import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalizeTerm } from "@/lib/ai/searchTerm";

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let body: { term?: string; resultCount?: number; locale?: string };
  try {
    body = await req.json();
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  const term = normalizeTerm(String(body.term ?? ""));
  if (!term) return new NextResponse(null, { status: 204 });

  const restaurant = await db.restaurant.findUnique({ where: { slug }, select: { id: true } });
  if (!restaurant) return new NextResponse(null, { status: 204 });

  const resultCount = Number.isFinite(body.resultCount) ? Math.max(0, Math.trunc(body.resultCount as number)) : 0;
  try {
    await db.searchEvent.create({
      data: {
        restaurantId: restaurant.id,
        term,
        rawTerm: String(body.term ?? "").slice(0, 120),
        resultCount,
        hadResults: resultCount > 0,
        locale: body.locale ? String(body.locale).slice(0, 5) : null,
      },
    });
  } catch {
    // best-effort: nunca rompemos la búsqueda del comensal
  }
  return new NextResponse(null, { status: 204 });
}
