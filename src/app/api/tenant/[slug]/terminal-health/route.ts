import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { COLLECTOR_ROLES, staffForRestaurant } from "@/lib/staffAccess";
import { readTerminalWarnings } from "@/lib/payments/terminalHealth";
import { timezoneForCountry } from "@/lib/ai/tools/dateRange";
import { secureApi } from "@/lib/secureApi";

async function GETHandler(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug }, select: { id: true, country: true } });
  if (!tenant || !await staffForRestaurant(tenant.id, COLLECTOR_ROLES)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    warnings: await readTerminalWarnings(tenant.id),
    timeZone: timezoneForCountry(tenant.country),
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export const GET = secureApi(GETHandler);
