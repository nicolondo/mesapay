import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const schema = z.object({
  status: z.enum(["generated", "rejected", "pending"]),
  notes: z.string().trim().max(500).optional(),
});

/**
 * Operator marks an invoice request as generated (most common), rejected,
 * or back to pending (if they made a mistake). The actual electronic
 * invoice is emitted from the restaurant's own provider — we just track
 * the workflow state here.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const { id } = await params;
  const reqRow = await db.invoiceRequest.findUnique({ where: { id } });
  if (!reqRow || reqRow.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  await db.invoiceRequest.update({
    where: { id },
    data: {
      status: parsed.data.status,
      notes: parsed.data.notes ?? reqRow.notes,
      generatedAt: parsed.data.status === "generated" ? new Date() : null,
      generatedByEmail:
        parsed.data.status === "generated" ? session.user.email : null,
    },
  });
  return NextResponse.json({ ok: true });
}
