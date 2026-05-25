import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";

const schema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(200),
    auth: z.string().min(1).max(200),
  }),
});

/**
 * Register a Web Push subscription for the current user. Called from
 * the client after PushManager.subscribe() succeeds. Re-subscribing
 * with the same endpoint just updates the keys (no duplicates).
 *
 * Saves the current user's restaurantId on the row so push fan-outs
 * by restaurant don't need to join through user.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const userAgent = req.headers.get("user-agent") ?? null;

  // Upsert by endpoint — the same browser re-subscribing should reuse
  // the row rather than creating a duplicate that would notify twice.
  await db.pushSubscription.upsert({
    where: { endpoint: parsed.data.endpoint },
    create: {
      userId: session.user.id,
      restaurantId: session.user.restaurantId ?? null,
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      userAgent,
    },
    update: {
      userId: session.user.id,
      restaurantId: session.user.restaurantId ?? null,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      userAgent,
    },
  });

  return NextResponse.json({ ok: true });
}
