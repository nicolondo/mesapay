import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

/**
 * Auto-asignación de mesas por el mesero desde su PWA.
 *
 * Reglas:
 *  - Una mesa pertenece a UN solo mesero a la vez (exclusiva).
 *  - Tomar (assign=true): si la mesa la tiene OTRO mesero, solo se le
 *    puede quitar cuando está LIBRE (sin pedido activo). Si está ocupada,
 *    se rechaza (409 "occupied") — no se le roba la mesa a quien la
 *    atiende. Si nadie la tiene, se toma siempre (esté libre u ocupada).
 *  - Soltar (assign=false): el mesero quita una de sus mesas cuando quiera.
 *
 * Concurrencia: todo corre dentro de una transacción con un advisory lock
 * por restaurante (pg_advisory_xact_lock), así dos meseros que tocan la
 * misma mesa a la vez se serializan y nunca terminan ambos con la mesa.
 */
const schema = z.object({
  number: z.number().int().min(1).max(999),
  assign: z.boolean(),
});

export async function POST(req: Request) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!session?.user || !userId || session.user.role !== "mesero") {
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
  const { number, assign } = parsed.data;

  const result = await db.$transaction(async (tx) => {
    // Serializa las asignaciones de ESTE restaurante. Se libera al commit.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${restaurantId}), 42)`;

    const me = await tx.user.findUnique({
      where: { id: userId },
      select: { assignedTableNumbers: true, restaurantId: true },
    });
    if (!me || me.restaurantId !== restaurantId) {
      return { status: 403 as const, error: "forbidden" };
    }
    const mine = me.assignedTableNumbers;

    // Soltar.
    if (!assign) {
      if (mine.includes(number)) {
        await tx.user.update({
          where: { id: userId },
          data: { assignedTableNumbers: mine.filter((n) => n !== number) },
        });
      }
      return { status: 200 as const };
    }

    // Tomar. ¿La tiene otro mesero?
    const holders = await tx.user.findMany({
      where: {
        restaurantId,
        role: "mesero",
        id: { not: userId },
        assignedTableNumbers: { has: number },
      },
      select: { id: true, name: true, email: true, assignedTableNumbers: true },
    });

    if (holders.length > 0) {
      // Solo se la podemos quitar si está libre (sin pedido activo).
      const activeOrder = await tx.order.findFirst({
        where: {
          restaurantId,
          status: { notIn: ["paid", "cancelled"] },
          table: { number },
        },
        select: { id: true },
      });
      if (activeOrder) {
        const h = holders[0];
        return {
          status: 409 as const,
          error: "occupied",
          holder: h.name?.trim() || h.email.split("@")[0],
        };
      }
      // Libre → se la quitamos a quien la tenga.
      for (const h of holders) {
        await tx.user.update({
          where: { id: h.id },
          data: {
            assignedTableNumbers: h.assignedTableNumbers.filter(
              (n) => n !== number,
            ),
          },
        });
      }
    }

    if (!mine.includes(number)) {
      await tx.user.update({
        where: { id: userId },
        data: {
          assignedTableNumbers: [...mine, number].sort((a, b) => a - b),
        },
      });
    }
    return { status: 200 as const };
  });

  if (result.status !== 200) {
    return NextResponse.json(
      {
        error: result.error,
        holder: "holder" in result ? result.holder : undefined,
      },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true });
}
