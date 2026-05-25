import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const putBody = z.object({
  tableNumbers: z.array(z.number().int()).max(500),
});

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

/**
 * Operator-managed assignment of dining-room table numbers to a single
 * mesero user. Empty array = "atiende todo" (no scope applied at
 * query time). Populated = mesero only sees those tables in Salón /
 * Cobros / Mesas.
 *
 * Tenant-scoped: we verify the target user belongs to the operator's
 * own restaurant so an admin of restaurant A can't reassign tables
 * for a mesero of restaurant B by guessing the user id.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = putBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  // Tenant guard + role guard on the target.
  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, role: true, restaurantId: true },
  });
  if (!target || target.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (target.role !== "mesero") {
    return NextResponse.json(
      { error: "only_mesero_supported" },
      { status: 400 },
    );
  }

  // Validate the table numbers exist in this restaurant. Silently
  // drop anything that doesn't match — the UI can still surface
  // "removed N invalid numbers" if it wants, but server-side we
  // just keep the intersection so the stored config is always
  // sound.
  const existing = await db.table.findMany({
    where: { restaurantId },
    select: { number: true },
  });
  const valid = new Set(existing.map((t) => t.number));
  const clean = Array.from(
    new Set(parsed.data.tableNumbers.filter((n) => valid.has(n))),
  ).sort((a, b) => a - b);

  await db.user.update({
    where: { id },
    data: { assignedTableNumbers: clean },
  });

  return NextResponse.json({ ok: true, tableNumbers: clean });
}
