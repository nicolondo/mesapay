import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { db } from "@/lib/db";

const schema = z.object({
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  name: z.string().trim().min(1).max(80).optional(),
  password: z.string().min(8).max(200),
  role: z.enum(["operator", "terminal", "platform_admin"]),
  // Required for operator + terminal; ignored for platform_admin.
  restaurantId: z.string().min(1).optional(),
});

/**
 * Create a new user. Platform-admin-only. Used to add additional operators,
 * terminal (datáfono) users, or other platform admins.
 *
 * If creating a tenant-scoped role (operator / terminal), restaurantId is
 * required and validated. platform_admin users are global and ignore
 * restaurantId.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { email, name, password, role, restaurantId } = parsed.data;

  if (role !== "platform_admin") {
    if (!restaurantId) {
      return NextResponse.json(
        { error: "restaurant_required" },
        { status: 400 },
      );
    }
    const rest = await db.restaurant.findUnique({ where: { id: restaurantId } });
    if (!rest) {
      return NextResponse.json({ error: "restaurant_not_found" }, { status: 404 });
    }
  }

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await db.user.create({
    data: {
      email,
      name: name ?? null,
      passwordHash,
      role,
      restaurantId: role === "platform_admin" ? null : restaurantId!,
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      restaurantId: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ ok: true, user });
}
