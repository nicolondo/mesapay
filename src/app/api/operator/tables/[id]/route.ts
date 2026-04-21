import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";

const patchSchema = z.object({
  label: z.string().trim().max(40).nullable().optional(),
});

async function guard(id: string) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return { error: "unauthorized" as const };
  }
  const table = await db.table.findUnique({ where: { id } });
  if (!table) return { error: "not found" as const };
  if (
    session.user.role === "operator" &&
    table.restaurantId !== session.user.restaurantId
  ) {
    return { error: "forbidden" as const };
  }
  return { table };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const g = await guard(id);
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
