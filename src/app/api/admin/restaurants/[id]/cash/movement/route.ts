import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { recordCashMovement } from "@/lib/cashBox";

const schema = z.object({
  kind: z.enum(["egreso", "ingreso"]),
  amountCents: z.number().int().min(1).max(10_000_000_000),
  concept: z.string().trim().min(1).max(200),
});

/** Egreso/ingreso de caja de un comercio, desde el admin de plataforma. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const restaurant = await db.restaurant.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!restaurant) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  await recordCashMovement({
    restaurantId: id,
    kind: parsed.data.kind,
    amountCents: parsed.data.amountCents,
    concept: parsed.data.concept,
    createdById: session.user.id,
  });
  return NextResponse.json({ ok: true });
}
