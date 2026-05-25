import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";

const schema = z.object({
  endpoint: z.string().url(),
});

/**
 * Remove a Web Push subscription. Only the owning user (or an admin)
 * can delete a row — the endpoint alone isn't enough to authenticate
 * the delete, so we double-check by userId.
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
  await db.pushSubscription.deleteMany({
    where: {
      endpoint: parsed.data.endpoint,
      userId: session.user.id,
    },
  });
  return NextResponse.json({ ok: true });
}
