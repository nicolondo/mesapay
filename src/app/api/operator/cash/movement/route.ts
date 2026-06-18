import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { recordCashMovement } from "@/lib/cashBox";

const schema = z.object({
  kind: z.enum(["egreso", "ingreso"]),
  amountCents: z.number().int().min(1).max(10_000_000_000),
  concept: z.string().trim().min(1).max(200),
});

/** Registra un egreso/ingreso de la caja general (operator o admin). */
export async function POST(req: Request) {
  const session = await auth();
  const role = session?.user?.role;
  if (!session?.user || (role !== "operator" && role !== "platform_admin")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  await recordCashMovement({
    restaurantId,
    kind: parsed.data.kind,
    amountCents: parsed.data.amountCents,
    concept: parsed.data.concept,
    createdById: session.user.id,
  });
  return NextResponse.json({ ok: true });
}
