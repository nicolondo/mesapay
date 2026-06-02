import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const patchSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  active: z.boolean().optional(),
  // Serial físico del datáfono (Cloud Terminal API). "" → null.
  serialNumber: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .optional()
    .transform((v) => (v ? v : v === "" ? null : v)),
  // null = unassign (the device becomes shared / available for anyone
  // to push from Salón). string = assigned to that mesero.
  assignedUserId: z.string().min(1).nullable().optional(),
});

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

/**
 * Operator-managed config for a TerminalDevice. Lets the restaurant
 * tie a Smart POS to a specific mesero so that when the mesero hits
 * "Cobrar con datáfono" the system already knows which device to push
 * to — no Salón roundtrip needed.
 */
export async function PATCH(
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
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const device = await db.terminalDevice.findUnique({ where: { id } });
  if (!device || device.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // If reassigning to a user, validate that user belongs to this
  // restaurant AND has a role that can actually use a datáfono.
  if (parsed.data.assignedUserId) {
    const user = await db.user.findUnique({
      where: { id: parsed.data.assignedUserId },
      select: { id: true, role: true, restaurantId: true },
    });
    if (
      !user ||
      user.restaurantId !== restaurantId ||
      !["mesero", "operator", "terminal"].includes(user.role)
    ) {
      return NextResponse.json(
        { error: "invalid_user" },
        { status: 400 },
      );
    }
  }

  const updated = await db.terminalDevice.update({
    where: { id },
    data: {
      ...(parsed.data.label !== undefined && { label: parsed.data.label }),
      ...(parsed.data.active !== undefined && { active: parsed.data.active }),
      ...(parsed.data.serialNumber !== undefined && {
        serialNumber: parsed.data.serialNumber,
      }),
      ...(parsed.data.assignedUserId !== undefined && {
        assignedUserId: parsed.data.assignedUserId,
      }),
    },
    select: {
      id: true,
      label: true,
      active: true,
      serialNumber: true,
      assignedUserId: true,
    },
  });

  return NextResponse.json({ ok: true, device: updated });
}
