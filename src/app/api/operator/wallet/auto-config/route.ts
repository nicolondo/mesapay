import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const policySchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }),
  z.object({
    enabled: z.literal(true),
    mode: z.enum(["daily", "weekly", "threshold"]),
    thresholdCents: z.number().int().min(10000).optional(),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  }),
]);

export async function GET() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { autoDispersePolicy: true },
  });
  return NextResponse.json({
    policy: tenant?.autoDispersePolicy ?? { enabled: false },
  });
}

export async function POST(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const parsed = policySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  await db.restaurant.update({
    where: { id: restaurantId },
    data: { autoDispersePolicy: parsed.data },
  });
  return NextResponse.json({ ok: true });
}
