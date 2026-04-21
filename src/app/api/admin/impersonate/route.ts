import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { IMPERSONATE_COOKIE } from "@/lib/activeRestaurant";

const postSchema = z.object({ restaurantId: z.string().min(1) });

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const rest = await db.restaurant.findUnique({
    where: { id: parsed.data.restaurantId },
    select: { id: true },
  });
  if (!rest) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const jar = await cookies();
  jar.set(IMPERSONATE_COOKIE, rest.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 4,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const jar = await cookies();
  jar.delete(IMPERSONATE_COOKIE);
  return NextResponse.json({ ok: true });
}
