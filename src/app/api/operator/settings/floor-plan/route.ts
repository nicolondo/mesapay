import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  FLOOR_LABEL_MAX,
  FLOOR_MAX_MARKERS,
  FLOOR_MAX_TABLES,
  FLOOR_MAX_ZONES,
  FLOOR_MAX_ZONE_POINTS,
  FLOOR_PLAN_VERSION,
  FLOOR_WORLD,
  MARKER_KIND_LIST,
  MARKER_SIZE_MAX,
  MARKER_SIZE_MIN,
  TABLE_SIZE_MAX,
  TABLE_SIZE_MIN,
  ZONE_KIND_LIST,
  buildStoredFloorPlan,
  projectToLegacy,
  resolveLegacyFloorPlan,
  sanitizePlacement,
  sanitizeScene,
  type TablePlacement,
} from "@/lib/floorPlan";
import type { Prisma } from "@prisma/client";

/**
 * Guarda el plano del salón en una sola llamada. Operador / admin,
 * acotado al restaurante activo: cualquier id de mesa ajeno se descarta.
 *
 * Acepta DOS cuerpos, porque el deploy es blue/green y puede haber una
 * pestaña abierta con el editor anterior:
 *
 *   Libre (v2) — lo que manda el editor nuevo:
 *     PUT { version: 2,
 *           tables: [{ id, shape?, capacity?, label?, placement | null }],
 *           scene: { zones: [{ id, kind, label, points }],
 *                    markers: [{ id, kind, label, x, y, w, h, rotation }] } }
 *     Escribe las columnas libres de cada mesa, el blob con `version: 2`
 *     y, además, la proyección en celdas (Table.floorPlanX/Y y las claves
 *     viejas del blob) para la versión anterior.
 *
 *   Celdas (v1) — lo que manda el editor viejo:
 *     PUT { positions: [{ id, x, y, shape? }], floorPlan?: { cols, rows, zones, markers } }
 *     Se guarda exactamente como antes: el blob queda SIN `version`, y
 *     por eso vuelve a mandar el plano de celdas (se convierte al leer).
 *
 * Todo lo que llega se valida con zod (rangos, máximos, números finitos)
 * y se normaliza con los mismos helpers puros que usa el front.
 */

const ZONE_KINDS = ZONE_KIND_LIST as [string, ...string[]];
const MARKER_KINDS = MARKER_KIND_LIST as [string, ...string[]];
const SHAPES = ["square", "round", "bar"] as const;

// zod 4: z.number() ya rechaza NaN e Infinity.
const coord = z.number().min(0).max(FLOOR_WORLD);
const rotation = z.number().min(-3600).max(3600);

const placementSchema = z.object({
  x: coord,
  y: coord,
  w: z.number().min(TABLE_SIZE_MIN).max(TABLE_SIZE_MAX),
  h: z.number().min(TABLE_SIZE_MIN).max(TABLE_SIZE_MAX),
  rotation,
});

const v2Schema = z.object({
  version: z.literal(FLOOR_PLAN_VERSION),
  tables: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        shape: z.enum(SHAPES).optional(),
        capacity: z.number().int().min(1).max(40).optional(),
        label: z.string().max(FLOOR_LABEL_MAX).nullable().optional(),
        placement: placementSchema.nullable(),
      }),
    )
    .max(FLOOR_MAX_TABLES),
  scene: z.object({
    zones: z
      .array(
        z.object({
          id: z.string().min(1).max(40),
          kind: z.enum(ZONE_KINDS),
          label: z.string().max(FLOOR_LABEL_MAX).optional().default(""),
          points: z
            .array(z.object({ x: coord, y: coord }))
            .min(3)
            .max(FLOOR_MAX_ZONE_POINTS),
        }),
      )
      .max(FLOOR_MAX_ZONES),
    markers: z
      .array(
        z.object({
          id: z.string().min(1).max(40),
          kind: z.enum(MARKER_KINDS),
          label: z.string().max(FLOOR_LABEL_MAX).nullable().optional(),
          x: coord,
          y: coord,
          w: z.number().min(MARKER_SIZE_MIN).max(MARKER_SIZE_MAX),
          h: z.number().min(MARKER_SIZE_MIN).max(MARKER_SIZE_MAX),
          rotation,
        }),
      )
      .max(FLOOR_MAX_MARKERS),
  }),
});

/* Cuerpo del editor anterior (celdas). Idéntico al que aceptaba la ruta. */
const legacyZoneSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(ZONE_KINDS),
  label: z.string().max(40).optional().default(""),
  cells: z
    .array(
      z.object({
        x: z.number().int().min(0).max(50),
        y: z.number().int().min(0).max(50),
      }),
    )
    .min(1)
    .max(400),
});
const legacyMarkerSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(["entrada", "banos", "barra", "escaleras", "cocina"]),
  label: z.string().max(40).nullable().optional(),
  x: z.number().int().min(0).max(50),
  y: z.number().int().min(0).max(50),
});
const legacySchema = z.object({
  positions: z
    .array(
      z.object({
        id: z.string().min(1),
        x: z.number().int().min(0).max(50).nullable(),
        y: z.number().int().min(0).max(50).nullable(),
        shape: z.enum(SHAPES).optional(),
      }),
    )
    .max(FLOOR_MAX_TABLES),
  floorPlan: z
    .object({
      cols: z.number().int().min(1).max(50),
      rows: z.number().int().min(1).max(50),
      zones: z.array(legacyZoneSchema).max(60),
      markers: z.array(legacyMarkerSchema).max(60),
    })
    .optional(),
});

function samePlacement(
  row: {
    floorX: number | null;
    floorY: number | null;
    floorW: number | null;
    floorH: number | null;
    floorRotation: number | null;
  },
  p: TablePlacement | null,
): boolean {
  if (!p) {
    return (
      row.floorX === null &&
      row.floorY === null &&
      row.floorW === null &&
      row.floorH === null &&
      row.floorRotation === null
    );
  }
  return (
    row.floorX === p.x &&
    row.floorY === p.y &&
    row.floorW === p.w &&
    row.floorH === p.h &&
    row.floorRotation === p.rotation
  );
}

async function PUTHandler(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin" && session.user.role !== "group_admin")
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const body: unknown = await req.json().catch(() => null);
  const isV2 =
    !!body &&
    typeof body === "object" &&
    (body as Record<string, unknown>).version === FLOOR_PLAN_VERSION;

  if (!isV2) return saveLegacy(restaurantId, body);

  const parsed = v2Schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  // Solo mesas reales (número ≥ 0) de ESTE restaurante. Las ocultas
  // (recogida, facturas manuales) no van al plano.
  const ids = [...new Set(parsed.data.tables.map((t) => t.id))];
  const owned = await db.table.findMany({
    where: { id: { in: ids }, restaurantId, number: { gte: 0 } },
    select: {
      id: true,
      number: true,
      shape: true,
      capacity: true,
      label: true,
      floorPlanX: true,
      floorPlanY: true,
      floorX: true,
      floorY: true,
      floorW: true,
      floorH: true,
      floorRotation: true,
    },
  });
  const byId = new Map(owned.map((t) => [t.id, t]));

  const scene = sanitizeScene(parsed.data.scene);

  // Colocación final de cada mesa propia que llegó (la última gana si un
  // id viene repetido).
  const incoming = new Map<string, (typeof parsed.data.tables)[number]>();
  for (const t of parsed.data.tables) if (byId.has(t.id)) incoming.set(t.id, t);
  const placements = new Map<string, TablePlacement | null>();
  for (const [id, t] of incoming) {
    placements.set(id, t.placement ? sanitizePlacement(t.placement) : null);
  }

  // Proyección en celdas para la versión anterior de la app.
  const placedForLegacy: { id: string; number: number; placement: TablePlacement }[] = [];
  for (const [id, p] of placements) {
    const row = byId.get(id);
    if (p && row) placedForLegacy.push({ id, number: row.number, placement: p });
  }
  const legacy = projectToLegacy(scene, placedForLegacy);

  const writes: Prisma.PrismaPromise<unknown>[] = [];
  for (const [id, t] of incoming) {
    const row = byId.get(id);
    if (!row) continue;
    const p = placements.get(id) ?? null;
    const cell = p ? legacy.cells[id] ?? null : null;
    const label =
      t.label === undefined ? undefined : t.label === null ? null : t.label.trim() || null;
    const data: Prisma.TableUpdateInput = {};
    if (!samePlacement(row, p)) {
      data.floorX = p?.x ?? null;
      data.floorY = p?.y ?? null;
      data.floorW = p?.w ?? null;
      data.floorH = p?.h ?? null;
      data.floorRotation = p?.rotation ?? null;
    }
    if (row.floorPlanX !== (cell?.x ?? null) || row.floorPlanY !== (cell?.y ?? null)) {
      data.floorPlanX = cell?.x ?? null;
      data.floorPlanY = cell?.y ?? null;
    }
    if (t.shape !== undefined && t.shape !== row.shape) data.shape = t.shape;
    if (t.capacity !== undefined && t.capacity !== row.capacity) data.capacity = t.capacity;
    if (label !== undefined && label !== row.label) data.label = label;
    if (Object.keys(data).length === 0) continue;
    writes.push(db.table.update({ where: { id }, data }));
  }

  writes.push(
    db.restaurant.update({
      where: { id: restaurantId },
      data: {
        floorPlan: buildStoredFloorPlan(scene, legacy.plan) as unknown as Prisma.InputJsonValue,
      },
    }),
  );

  await db.$transaction(writes);

  return NextResponse.json({ ok: true, saved: incoming.size });
}

/**
 * Guardado del editor ANTERIOR (celdas), sin cambios de comportamiento.
 * Deja el blob sin `version`: a partir de ahí vuelve a mandar el plano de
 * celdas y el editor nuevo lo convierte al abrirlo.
 */
async function saveLegacy(restaurantId: string, body: unknown) {
  const parsed = legacySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

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

  if (parsed.data.floorPlan) {
    const clean = resolveLegacyFloorPlan(parsed.data.floorPlan);
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

export const PUT = secureApi(PUTHandler);
