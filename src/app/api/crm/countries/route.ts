import { NextResponse } from "next/server";
import { getCrmContext } from "@/lib/crm/access";
import { db } from "@/lib/db";

/**
 * GET /api/crm/countries?enabledOnly=1
 * Returns CrmCountry rows visible to CRM roles.
 * Used by the create-lead form to populate country selector.
 */
export async function GET(req: Request) {
  const ctx = await getCrmContext();
  if (!ctx) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const enabledOnly = searchParams.get("enabledOnly") === "1";

  const countries = await db.crmCountry.findMany({
    where: enabledOnly ? { enabled: true } : undefined,
    orderBy: { name: "asc" },
    select: { code: true, name: true, enabled: true },
  });

  return NextResponse.json({ countries });
}
