import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

/**
 * Detalle lightweight de una orden — usado por el sheet de detalle de
 * mesa del PWA mesero (poll cada 15s mientras está abierto). Devuelve
 * rondas + items con estado de cocina + timestamps suficientes para
 * computar ETA. No incluye totales, pagos ni datos sensibles.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  // Mismo allow-list que los otros endpoints del board operativo.
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" &&
      session.user.role !== "mesero" &&
      session.user.role !== "kitchen" &&
      session.user.role !== "bar")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const order = await db.order.findUnique({
    where: { id },
    include: {
      rounds: {
        orderBy: { seq: "asc" },
        include: {
          items: { orderBy: { id: "asc" } },
        },
      },
    },
  });
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const activeId = await getActiveRestaurantId();
  if (order.restaurantId !== activeId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    rounds: order.rounds.map((r) => ({
      id: r.id,
      seq: r.seq,
      status: r.status,
      placedAt: r.placedAt.toISOString(),
      items: r.items.map((i) => ({
        id: i.id,
        name: i.nameSnapshot,
        qty: i.qty,
        priceCents: i.priceCentsSnapshot,
        kitchenStatus: i.kitchenStatus,
        preparationStartedAt: i.preparationStartedAt
          ? i.preparationStartedAt.toISOString()
          : null,
        servedAt: i.servedAt ? i.servedAt.toISOString() : null,
        expediteRequestedAt: i.expediteRequestedAt
          ? i.expediteRequestedAt.toISOString()
          : null,
        guestName: i.guestName ?? null,
        notes: i.notes ?? null,
      })),
    })),
  });
}
