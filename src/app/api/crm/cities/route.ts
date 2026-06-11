import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";

const CRM_ROLES = new Set(["comercial", "gerente_comercial", "platform_admin"]);

// ── GET /api/crm/cities?country=CO&q=med ────────────────────────────────────

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.role || !CRM_ROLES.has(session.user.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const country = searchParams.get("country");
  const q = searchParams.get("q") ?? "";

  if (!country) {
    return NextResponse.json({ error: "missing_country" }, { status: 400 });
  }

  // isMain first, then alpha. Filter by name contains q (case-insensitive).
  const cities = await db.crmCity.findMany({
    where: {
      countryCode: country.toUpperCase(),
      ...(q.trim()
        ? { name: { contains: q.trim(), mode: "insensitive" } }
        : {}),
    },
    orderBy: [{ isMain: "desc" }, { name: "asc" }],
    take: 50,
    select: { id: true, name: true, isMain: true },
  });

  return NextResponse.json({ cities });
}
