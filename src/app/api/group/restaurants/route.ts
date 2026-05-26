import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { recordAuditEvent } from "@/lib/auditLog";

/**
 * Crea un restaurante nuevo bajo el grupo del usuario autenticado.
 * Sólo group_admin (con groupId válido) puede llamar.
 *
 * Crea:
 *   - Restaurant con groupId asignado
 *   - Una mesa inicial (número 1, o número 0 para counter mode)
 *   - NO crea un user owner — el group_admin que ya existe es quien
 *     lo gestiona. Si necesita un operator on-site, lo crea aparte
 *     desde /group/users.
 *
 * Plan inicial: `trial` (igual que el signup público). El admin
 * de plataforma puede ajustar después si el grupo tiene tarifa
 * negociada.
 */

const schema = z.object({
  name: z.string().trim().min(1).max(80),
  // Slug global — debe ser único en TODA la plataforma (no sólo
  // dentro del grupo). El frontend sugiere algo basado en el nombre
  // pero el operador puede cambiarlo.
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,40}$/, "Slug inválido (2-40 chars, a-z 0-9 -)"),
  serviceMode: z.enum(["table", "counter"]).optional().default("table"),
});

// Slugs reservados para que un comercio no se quede con una ruta
// del sistema. Idealmente importar desde lib/registerRestaurant pero
// la lista chica acá evita el coupling.
const RESERVED = new Set([
  "admin",
  "api",
  "group",
  "operator",
  "signin",
  "signup",
  "mesero",
  "terminal",
  "factura",
  "p",
  "t",
  "_next",
  "static",
]);

export async function POST(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    session.user.role !== "group_admin" ||
    !session.user.groupId
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: "invalid", message: first?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }

  const { name, slug, serviceMode } = parsed.data;
  if (RESERVED.has(slug)) {
    return NextResponse.json(
      { error: "reserved", message: "Ese slug está reservado." },
      { status: 400 },
    );
  }

  const existing = await db.restaurant.findUnique({ where: { slug } });
  if (existing) {
    return NextResponse.json(
      { error: "slug_taken", message: "Ese slug ya está en uso." },
      { status: 409 },
    );
  }

  const groupId = session.user.groupId;

  const result = await db.$transaction(async (tx) => {
    const restaurant = await tx.restaurant.create({
      data: {
        slug,
        name,
        serviceMode,
        groupId,
      },
    });
    await tx.table.create({
      data: {
        restaurantId: restaurant.id,
        number: serviceMode === "counter" ? 0 : 1,
        label: serviceMode === "counter" ? "Mostrador" : null,
        qrToken: randomBytes(16).toString("hex"),
      },
    });
    return restaurant;
  });

  await recordAuditEvent({
    kind: "restaurant.create",
    restaurantId: result.id,
    target: { type: "restaurant", id: result.id },
    summary: `Creó restaurante "${name}" en el grupo`,
    diff: {
      after: { slug, name, serviceMode, groupId },
    },
  });

  return NextResponse.json({
    ok: true,
    restaurantId: result.id,
    slug: result.slug,
  });
}
