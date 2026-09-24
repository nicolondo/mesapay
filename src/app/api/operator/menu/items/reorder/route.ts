import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { positionsFor } from "@/lib/menuOrder";

/**
 * Orden manual de los platos de UNA categoría (editor de la carta, modo
 * "manual"). El cliente manda la lista completa de la categoría en el orden
 * nuevo y acá se reescribe `sortOrder` (10, 20, 30…) en una transacción.
 *
 * Se exige la lista COMPLETA: todos los platos de esa categoría del comercio
 * activo (también los no disponibles, que el editor muestra atenuados), sin
 * repetidos ni ajenos. Si falta uno o sobra uno ajeno → 400 y no se toca
 * nada; el editor revierte y pide recargar. Con una lista parcial no habría
 * forma de saber dónde van los que faltan.
 */
const schema = z.object({
  categoryId: z.string().min(1),
  orderedIds: z.array(z.string().min(1)).min(1).max(1000),
});

async function PATCHHandler(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "group_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { categoryId, orderedIds } = parsed.data;
  if (new Set(orderedIds).size !== orderedIds.length) {
    return NextResponse.json({ error: "duplicate_ids" }, { status: 400 });
  }

  const category = await db.category.findUnique({
    where: { id: categoryId },
    select: { restaurantId: true },
  });
  if (!category || category.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "invalid_category" }, { status: 400 });
  }

  const result = await db.$transaction(async (tx) => {
    // Se lee DENTRO de la transacción: si alguien agregó o movió un plato
    // mientras tanto, la lista ya no coincide y se rechaza entera.
    const current = await tx.menuItem.findMany({
      where: { restaurantId, categoryId },
      select: { id: true, sortOrder: true },
    });
    const currentIds = new Set(current.map((c) => c.id));
    if (orderedIds.some((id) => !currentIds.has(id))) {
      return { error: "foreign_items" as const };
    }
    if (orderedIds.length !== current.length) {
      return { error: "incomplete" as const };
    }
    const next = positionsFor(orderedIds);
    const changed = current.filter((c) => next.get(c.id) !== c.sortOrder);
    for (const c of changed) {
      await tx.menuItem.update({
        where: { id: c.id, restaurantId },
        data: { sortOrder: next.get(c.id)! },
      });
    }
    return { positions: Object.fromEntries(next) };
  });

  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, positions: result.positions });
}

export const PATCH = secureApi(PATCHHandler);
