import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { computeEtaMinutes } from "@/lib/pickupEta";
import {
  isWithinEtaCap,
  pickupStatus,
} from "@/lib/pickupAvailability";

const schema = z.object({
  items: z
    .array(
      z.object({
        menuItemId: z.string().min(1),
        qty: z.number().int().min(1).max(20),
      }),
    )
    .min(1),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant || !tenant.pickupEnabled) {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const etaMinutes = await computeEtaMinutes(tenant.id, parsed.data.items);
  const status = pickupStatus(tenant.pickupHours);
  const withinCap = isWithinEtaCap(etaMinutes, tenant.pickupMaxEtaMinutes);
  return NextResponse.json({
    etaMinutes,
    open: status.open,
    nextOpenAt: status.nextOpenAt ? status.nextOpenAt.toISOString() : null,
    saturated: !withinCap,
    maxEtaMinutes: tenant.pickupMaxEtaMinutes,
  });
}
