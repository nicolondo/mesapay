import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { staffForRestaurant, COLLECTOR_ROLES } from "@/lib/staffAccess";
import { staffTerminalRequestKey } from "@/lib/payments/staffTerminalRequest";

// Locate the exact checkout request even when its POST response never arrived.
export const GET = secureApi(async (req: Request, { params }: {
  params: Promise<{ slug: string; orderId: string }>;
}) => {
  const { slug, orderId } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug }, select: { id: true } });
  if (!tenant || !await staffForRestaurant(tenant.id, COLLECTOR_ROLES)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const query = new URL(req.url).searchParams;
  const attempt = query.get("attempt");
  const method = query.get("method");
  if (!attempt || (method !== "kushki_card_terminal" && method !== "external_terminal")) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const request = await db.financialOperation.findUnique({
    where: { key: staffTerminalRequestKey(orderId, method, attempt) },
    select: { paymentId: true },
  });
  return NextResponse.json({ paymentId: request?.paymentId ?? null });
});
