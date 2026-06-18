import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrentShift } from "@/lib/shift";
import { publishOrderEvent } from "@/lib/events";
import { recordAuditEvent } from "@/lib/auditLog";

const schema = z.object({
  // shiftId ausente / null → base del turno GENERAL del local.
  // shiftId presente → base del turno PERSONAL de un mesero.
  shiftId: z.string().optional().nullable(),
  openingCashCents: z.number().int().min(0).max(10_000_000_000),
});

/**
 * Edita la base (openingCashCents) de un turno YA abierto. El operador
 * puede ajustar tanto la base del local como la de cualquier mesero.
 *
 * Invariante: la base de un mesero nunca puede superar la del local
 * (si el local tiene base 0, los meseros también deben estar en 0):
 *   - editar base de mesero → debe ser ≤ base del local.
 *   - bajar base del local  → no puede quedar por debajo de la base de
 *     algún mesero con turno abierto (se rechaza nombrando al mesero).
 */
export async function PATCH(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
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
  const { shiftId, openingCashCents } = parsed.data;

  const localShift = await getCurrentShift(restaurantId);
  if (!localShift) {
    return NextResponse.json({ error: "no_open_shift" }, { status: 409 });
  }

  // ── Base de un mesero ──────────────────────────────────────────────
  if (shiftId) {
    const target = await db.shift.findFirst({
      where: { id: shiftId, restaurantId, status: "open", NOT: { userId: null } },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!target) {
      return NextResponse.json({ error: "shift_not_found" }, { status: 404 });
    }
    if (openingCashCents > localShift.openingCashCents) {
      return NextResponse.json(
        { error: "base_exceeds_local", maxCents: localShift.openingCashCents },
        { status: 409 },
      );
    }
    const before = target.openingCashCents;
    await db.shift.update({
      where: { id: target.id },
      data: { openingCashCents },
    });
    await recordAuditEvent({
      kind: "cash.shift_base.update",
      restaurantId,
      target: { type: "shift", id: target.id },
      summary: `Editó base de ${target.user?.name ?? target.user?.email ?? "mesero"}`,
      diff: { before: { openingCashCents: before }, after: { openingCashCents } },
    });
    publishOrderEvent(restaurantId, { type: "cash.updated" });
    return NextResponse.json({ ok: true });
  }

  // ── Base del local ─────────────────────────────────────────────────
  // No puede quedar por debajo de la base de un mesero abierto.
  const openMeseros = await db.shift.findMany({
    where: { restaurantId, status: "open", NOT: { userId: null } },
    select: {
      openingCashCents: true,
      user: { select: { name: true, email: true } },
    },
    orderBy: { openingCashCents: "desc" },
  });
  const top = openMeseros[0];
  if (top && openingCashCents < top.openingCashCents) {
    return NextResponse.json(
      {
        error: "base_below_mesero",
        minCents: top.openingCashCents,
        meseroName: top.user?.name ?? top.user?.email ?? null,
      },
      { status: 409 },
    );
  }

  const before = localShift.openingCashCents;
  await db.shift.update({
    where: { id: localShift.id },
    data: { openingCashCents },
  });
  await recordAuditEvent({
    kind: "cash.shift_base.update",
    restaurantId,
    target: { type: "shift", id: localShift.id },
    summary: "Editó base del local",
    diff: { before: { openingCashCents: before }, after: { openingCashCents } },
  });
  publishOrderEvent(restaurantId, { type: "cash.updated" });
  return NextResponse.json({ ok: true });
}
