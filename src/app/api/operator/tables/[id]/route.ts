import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const patchSchema = z.object({
  label: z.string().trim().max(40).nullable().optional(),
});

async function guard(id: string, opts: { allowMesero?: boolean } = {}) {
  const session = await auth();
  const role = session?.user?.role;
  const allowed =
    role === "operator" ||
    role === "platform_admin" ||
    (opts.allowMesero === true && role === "mesero");
  if (!session?.user || !allowed) {
    return { error: "unauthorized" as const };
  }
  const table = await db.table.findUnique({ where: { id } });
  if (!table) return { error: "not found" as const };
  const activeId = await getActiveRestaurantId();
  if (table.restaurantId !== activeId) {
    return { error: "forbidden" as const };
  }
  return { table };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // PATCH solo cambia el label hoy — un mesero etiquetando una mesa
  // como "Terraza 3" o "Ventana" es legítimo. Borrado (DELETE) sigue
  // restringido al operador.
  const g = await guard(id, { allowMesero: true });
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  await db.table.update({
    where: { id },
    data: {
      label: parsed.data.label === undefined ? undefined : parsed.data.label,
    },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await guard(id);
  if ("error" in g) return NextResponse.json({ error: g.error }, { status: 403 });

  const openOrders = await db.order.count({
    where: { tableId: id, status: { notIn: ["paid", "cancelled"] } },
  });
  if (openOrders > 0) {
    return NextResponse.json(
      { error: "La mesa tiene un pedido abierto" },
      { status: 409 },
    );
  }
  const pastOrders = await db.order.count({ where: { tableId: id } });
  if (pastOrders > 0) {
    return NextResponse.json(
      { error: "La mesa tiene historial de pedidos. Archívala en vez de borrarla." },
      { status: 409 },
    );
  }

  await db.table.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
