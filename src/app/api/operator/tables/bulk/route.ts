import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

/**
 * Crear mesas en bulk por rango [from, to]. Salta los números que ya
 * existen (no falla), así se puede re-correr para "rellenar" huecos o
 * extender el rango más adelante. Devuelve cuántas creó y cuántas saltó.
 */
const schema = z
  .object({
    from: z.number().int().min(1).max(999),
    to: z.number().int().min(1).max(999),
  })
  .refine((d) => d.to >= d.from, { message: "range" })
  .refine((d) => d.to - d.from + 1 <= 200, { message: "tooMany" });

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
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const code = parsed.error.issues[0]?.message ?? "invalid";
    return NextResponse.json({ error: code }, { status: 400 });
  }
  const { from, to } = parsed.data;

  // Números que ya existen en el rango — para saltarlos.
  const existing = await db.table.findMany({
    where: { restaurantId, number: { gte: from, lte: to } },
    select: { number: true },
  });
  const taken = new Set(existing.map((t) => t.number));

  const toCreate: { restaurantId: string; number: number; qrToken: string }[] = [];
  for (let n = from; n <= to; n++) {
    if (taken.has(n)) continue;
    toCreate.push({
      restaurantId,
      number: n,
      qrToken: randomBytes(16).toString("hex"),
    });
  }

  if (toCreate.length > 0) {
    await db.table.createMany({ data: toCreate });
  }

  return NextResponse.json({
    created: toCreate.length,
    skipped: taken.size,
  });
}
