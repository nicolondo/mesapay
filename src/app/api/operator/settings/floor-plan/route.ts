import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { resolveFloorPlan } from "@/lib/floorPlan";
import type { Prisma } from "@prisma/client";

/**
 * Guarda el layout del salón en una sola llamada: posiciones (x,y) en
 * la grilla + forma de cada mesa, MÁS el plano (grilla + zonas + markers).
 * El editor manda TODAS las mesas que tocó. Una posición null/null saca
 * la mesa del plano (vuelve a la bandeja de "sin ubicar").
 *
 * Operator / admin only, tenant-scoped. Validamos que cada tableId
 * pertenezca al restaurante activo antes de escribir.
 *
 * PUT {
 *   positions: [{ id, x, y, shape? }],
 *   floorPlan?: { cols, rows, zones[], markers[] }
 * }
 */
const zoneSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum([
    "interior",
    "exterior",
    "terraza",
    "jardin",
    "barra",
    "cocina",
    "banos",
    "custom",
  ]),
  label: z.string().max(40).optional().default(""),
  x: z.number().int().min(0).max(50),
  y: z.number().int().min(0).max(50),
  w: z.number().int().min(1).max(50),
  h: z.number().int().min(1).max(50),
});
const markerSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(["entrada", "banos", "barra", "escaleras", "cocina"]),
  label: z.string().max(40).nullable().optional(),
  x: z.number().int().min(0).max(50),
  y: z.number().int().min(0).max(50),
});
const schema = z.object({
  positions: z
    .array(
      z.object({
        id: z.string().min(1),
        x: z.number().int().min(0).max(50).nullable(),
        y: z.number().int().min(0).max(50).nullable(),
        shape: z.enum(["square", "round", "bar"]).optional(),
      }),
    )
    .max(500),
  floorPlan: z
    .object({
      cols: z.number().int().min(1).max(50),
      rows: z.number().int().min(1).max(50),
      zones: z.array(zoneSchema).max(60),
      markers: z.array(markerSchema).max(60),
    })
    .optional(),
});

export async function PUT(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  // Tenant-scope: descartamos cualquier id que no sea del restaurante.
  const ids = parsed.data.positions.map((p) => p.id);
  const owned = await db.table.findMany({
    where: { id: { in: ids }, restaurantId },
    select: { id: true },
  });
  const ownedIds = new Set(owned.map((t) => t.id));

  const writes: Prisma.PrismaPromise<unknown>[] = parsed.data.positions
    .filter((p) => ownedIds.has(p.id))
    .map((p) =>
      db.table.update({
        where: { id: p.id },
        data: {
          floorPlanX: p.x,
          floorPlanY: p.y,
          ...(p.shape !== undefined && { shape: p.shape }),
        },
      }),
    );

  // El plano (grilla + zonas + markers) se normaliza con el mismo helper
  // que usa el front, así guardamos siempre algo válido y clampeado.
  if (parsed.data.floorPlan) {
    const clean = resolveFloorPlan(parsed.data.floorPlan);
    writes.push(
      db.restaurant.update({
        where: { id: restaurantId },
        data: { floorPlan: clean as unknown as Prisma.InputJsonValue },
      }),
    );
  }

  await db.$transaction(writes);

  return NextResponse.json({ ok: true, saved: ownedIds.size });
}
