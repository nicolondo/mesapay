import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { auth } from "@/auth";
import { recordAuditEvent } from "@/lib/auditLog";

/**
 * Endpoint admin para crear grupos y asignarles restaurantes
 * existentes (caso migración: cliente legacy con varios restaurantes
 * sueltos que ahora quiere gestionarlos juntos).
 *
 * Crea opcionalmente un user group_admin si se pasa adminEmail +
 * adminPassword. Si no, el grupo queda creado pero sin miembros —
 * se pueden vincular usuarios después.
 */

const RESERVED = new Set([
  "admin",
  "api",
  "group",
  "operator",
  "signin",
  "signup",
]);

const schema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]{2,40}$/, "Slug inválido"),
  name: z.string().trim().min(1).max(160),
  restaurantIds: z.array(z.string()).default([]),
  adminEmail: z.string().trim().email().optional(),
  adminName: z.string().trim().min(1).max(80).optional(),
  adminPassword: z.string().min(6).max(120).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
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
  const { slug, name, restaurantIds, adminEmail, adminName, adminPassword } =
    parsed.data;

  if (RESERVED.has(slug)) {
    return NextResponse.json(
      { error: "reserved", message: "Slug reservado" },
      { status: 400 },
    );
  }
  const existing = await db.group.findUnique({ where: { slug } });
  if (existing) {
    return NextResponse.json(
      { error: "slug_taken", message: "Ese slug ya está en uso" },
      { status: 409 },
    );
  }

  // Si se va a crear admin user, validar que el email no esté tomado.
  if (adminEmail) {
    const u = await db.user.findUnique({
      where: { email: adminEmail.toLowerCase() },
    });
    if (u) {
      return NextResponse.json(
        { error: "email_taken", message: "Ese email ya tiene cuenta." },
        { status: 409 },
      );
    }
    if (!adminPassword) {
      return NextResponse.json(
        {
          error: "invalid",
          message: "Si vas a crear admin, contraseña requerida.",
        },
        { status: 400 },
      );
    }
  }

  // Validar que los restaurantIds pasados existen y no pertenecen ya
  // a otro grupo (sería sobreescribir asignación previa — no lo
  // permito aquí, el admin tiene que despgruparlos primero).
  if (restaurantIds.length > 0) {
    const rests = await db.restaurant.findMany({
      where: { id: { in: restaurantIds } },
      select: { id: true, groupId: true, name: true },
    });
    if (rests.length !== restaurantIds.length) {
      return NextResponse.json(
        { error: "invalid", message: "Algún restaurante no existe" },
        { status: 400 },
      );
    }
    const alreadyGrouped = rests.filter((r) => r.groupId);
    if (alreadyGrouped.length > 0) {
      return NextResponse.json(
        {
          error: "already_grouped",
          message: `${alreadyGrouped.map((r) => r.name).join(", ")} ya pertenece(n) a otro grupo`,
        },
        { status: 409 },
      );
    }
  }

  const bcrypt = adminEmail
    ? (await import("bcryptjs")).default
    : null;
  const passwordHash = adminPassword && bcrypt
    ? await bcrypt.hash(adminPassword, 10)
    : null;

  const group = await db.$transaction(async (tx) => {
    const g = await tx.group.create({
      data: { slug, name },
    });
    if (restaurantIds.length > 0) {
      await tx.restaurant.updateMany({
        where: { id: { in: restaurantIds } },
        data: { groupId: g.id },
      });
    }
    if (adminEmail && passwordHash) {
      await tx.user.create({
        data: {
          email: adminEmail.toLowerCase(),
          name: adminName ?? null,
          passwordHash,
          role: "group_admin",
          groupId: g.id,
        },
      });
    }
    return g;
  });

  await recordAuditEvent({
    kind: "plan_catalog.update", // reusamos un kind generico de platform
    restaurantId: null,
    target: { type: "group", id: group.id },
    summary: `Creó grupo ${name}${restaurantIds.length ? ` con ${restaurantIds.length} restaurante(s)` : ""}`,
  });

  return NextResponse.json({ ok: true, groupId: group.id });
}
