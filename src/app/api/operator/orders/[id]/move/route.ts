import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { publishOrderEvent } from "@/lib/events";

const bodySchema = z.object({
  targetTableId: z.string().min(1),
});

/**
 * Mover una orden abierta de su mesa actual a otra. Caso clásico: el
 * cliente pidió cambio de mesa después de haber ordenado, o el mesero
 * acomodó accidentalmente la cuenta en la mesa equivocada.
 *
 * Reglas:
 *   - Ambas mesas deben pertenecer al mismo restaurante (tenant scope).
 *   - El mesero solo puede mover entre mesas dentro de su
 *     assignedTableNumbers (si tiene alguno asignado).
 *   - La mesa destino no debe tener otra orden abierta (evita merges
 *     accidentales que arruinarían la cuenta).
 *   - La orden de origen debe estar abierta (no paid / cancelled).
 *   - No se puede mover a la misma mesa (no-op).
 *
 * Publica `order.updated` con el restaurantId para que ambas mesas
 * (origen y destino) refresquen sus tarjetas en la grid de Mesas.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  const role = session?.user?.role;
  if (
    !session?.user ||
    (role !== "operator" &&
      role !== "platform_admin" &&
      role !== "mesero")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const order = await db.order.findUnique({
    where: { id },
    select: { id: true, restaurantId: true, tableId: true, status: true },
  });
  if (!order || order.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (order.status === "paid" || order.status === "cancelled") {
    return NextResponse.json(
      { error: "order_closed", message: "La cuenta ya está cerrada." },
      { status: 409 },
    );
  }
  if (order.tableId === parsed.data.targetTableId) {
    return NextResponse.json(
      {
        error: "same_table",
        message: "Esa ya es la mesa actual.",
      },
      { status: 400 },
    );
  }

  const target = await db.table.findUnique({
    where: { id: parsed.data.targetTableId },
    select: { id: true, number: true, restaurantId: true },
  });
  if (!target || target.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Scope mesa por número para meseros con asignación. Empty array
  // = atiende todas (sin restricción).
  if (role === "mesero") {
    const me = await db.user.findUnique({
      where: { id: session.user.id },
      select: { assignedTableNumbers: true },
    });
    const nums = me?.assignedTableNumbers ?? [];
    if (nums.length > 0 && !nums.includes(target.number)) {
      return NextResponse.json(
        {
          error: "target_out_of_scope",
          message: "Esa mesa no está en tu sección asignada.",
        },
        { status: 403 },
      );
    }
  }

  // ¿Mesa destino ya tiene cuenta abierta? Si la juntáramos sería
  // un merge implícito de dos órdenes — preferimos pedirle al
  // operador que cierre/cancele antes de mover.
  const targetOpen = await db.order.findFirst({
    where: {
      tableId: target.id,
      status: { notIn: ["paid", "cancelled"] },
    },
    select: { id: true, shortCode: true },
  });
  if (targetOpen) {
    return NextResponse.json(
      {
        error: "target_busy",
        message: `La mesa ${target.number} ya tiene una cuenta abierta (${targetOpen.shortCode}). Ciérrala antes de mover.`,
      },
      { status: 409 },
    );
  }

  await db.order.update({
    where: { id: order.id },
    data: { tableId: target.id },
  });

  // Refresh las dos tarjetas (origen y destino) en la grid de Mesas
  // + cualquier otra vista del flujo (Salón, kitchen) que dependa
  // del orderId. order.updated es el evento genérico que todas
  // escuchan.
  publishOrderEvent(restaurantId, {
    type: "order.updated",
    orderId: order.id,
  });

  return NextResponse.json({
    ok: true,
    targetTableNumber: target.number,
  });
}
