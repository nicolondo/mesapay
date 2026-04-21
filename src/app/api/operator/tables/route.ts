import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { auth } from "@/auth";

const createSchema = z.object({
  number: z.number().int().min(1).max(999),
  label: z.string().trim().max(40).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = session.user.restaurantId;
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const existing = await db.table.findUnique({
    where: {
      restaurantId_number: {
        restaurantId,
        number: parsed.data.number,
      },
    },
  });
  if (existing) {
    return NextResponse.json(
      { error: "Ya existe una mesa con ese número" },
      { status: 409 },
    );
  }

  const table = await db.table.create({
    data: {
      restaurantId,
      number: parsed.data.number,
      label: parsed.data.label?.trim() || null,
      qrToken: randomBytes(16).toString("hex"),
    },
  });

  return NextResponse.json({ id: table.id });
}
