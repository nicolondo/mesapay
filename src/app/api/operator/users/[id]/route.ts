import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

/**
 * Mismos roles que el endpoint de creación; ver
 * `/api/operator/users/route.ts`.
 */
const ASSIGNABLE_ROLES = [
  "operator",
  "mesero",
  "kitchen",
  "bar",
  "terminal",
] as const;

const patchBody = z
  .object({
    name: z
      .string()
      .trim()
      .max(80)
      .nullable()
      .optional(),
    email: z
      .string()
      .email("Email inválido")
      .transform((s) => s.toLowerCase().trim())
      .optional(),
    password: z
      .string()
      .min(6, "Mínimo 6 caracteres")
      .max(200)
      .optional(),
    role: z.enum(ASSIGNABLE_ROLES).optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.email !== undefined ||
      v.password !== undefined ||
      v.role !== undefined,
    { message: "Nada para actualizar" },
  );

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

/**
 * Editar nombre / email / contraseña / rol de un staff del restaurante
 * activo. Tenant-scoped + role-scoped:
 *
 *   - El target debe pertenecer al mismo restaurante.
 *   - No permitimos tocar usuarios `platform_admin` desde acá (se
 *     gestionan en /admin).
 *   - Nadie puede cambiarse el rol a sí mismo (evita auto-degradarse
 *     y quedar sin acceso al operador). Cambiar tu propio nombre,
 *     email o contraseña sí está permitido.
 *   - Si cambia el rol, reseteamos `assignedTableNumbers` salvo que
 *     el rol nuevo siga siendo mesero — el array solo aplica a meseros.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = patchBody.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: "invalid", message: first?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }

  const target = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      role: true,
      restaurantId: true,
      email: true,
    },
  });
  if (!target || target.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (target.role === "platform_admin") {
    return NextResponse.json(
      { error: "cannot_edit_platform_admin" },
      { status: 403 },
    );
  }

  const isSelf = session?.user?.id === target.id;
  if (parsed.data.role !== undefined && isSelf && parsed.data.role !== target.role) {
    return NextResponse.json(
      {
        error: "cannot_change_own_role",
        message: "No puedes cambiar tu propio rol",
      },
      { status: 400 },
    );
  }

  // Email unique check si cambia.
  if (parsed.data.email && parsed.data.email !== target.email) {
    const taken = await db.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true },
    });
    if (taken && taken.id !== target.id) {
      return NextResponse.json(
        { error: "email_taken", message: "Ya existe un usuario con ese email" },
        { status: 409 },
      );
    }
  }

  const data: {
    name?: string | null;
    email?: string;
    role?: (typeof ASSIGNABLE_ROLES)[number];
    passwordHash?: string;
    assignedTableNumbers?: number[];
  } = {};

  if (parsed.data.name !== undefined) {
    data.name = parsed.data.name && parsed.data.name.length > 0 ? parsed.data.name : null;
  }
  if (parsed.data.email !== undefined) data.email = parsed.data.email;
  if (parsed.data.role !== undefined) {
    data.role = parsed.data.role;
    // Cambio de rol → si ya no es mesero, limpiamos asignaciones de mesas.
    if (parsed.data.role !== "mesero" && target.role === "mesero") {
      data.assignedTableNumbers = [];
    }
  }
  if (parsed.data.password !== undefined) {
    data.passwordHash = await bcrypt.hash(parsed.data.password, 10);
  }

  const updated = await db.user.update({
    where: { id: target.id },
    data,
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      assignedTableNumbers: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ ok: true, user: updated });
}

/**
 * Borrar un staff del restaurante activo. Tenant-scoped y con los
 * mismos límites que PATCH:
 *
 *   - Nunca borrar a un platform_admin desde acá.
 *   - Nunca dejarte borrar a ti mismo (te quedarías sin sesión).
 *
 * Si el usuario es el dueño de pedidos abiertos (Order.userId), Prisma
 * lo bloqueará por la FK — devolvemos 409 con mensaje legible.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const { id } = await params;

  const target = await db.user.findUnique({
    where: { id },
    select: { id: true, role: true, restaurantId: true },
  });
  if (!target || target.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (target.role === "platform_admin") {
    return NextResponse.json(
      { error: "cannot_delete_platform_admin" },
      { status: 403 },
    );
  }
  if (session?.user?.id === target.id) {
    return NextResponse.json(
      {
        error: "cannot_delete_self",
        message: "No puedes eliminar tu propio usuario",
      },
      { status: 400 },
    );
  }

  try {
    await db.user.delete({ where: { id: target.id } });
  } catch (err) {
    // Foreign-key violation típica: Prisma error code P2003 / P2014.
    // Devolvemos algo legible sin filtrar el detalle.
    console.error("[users.delete] failed", err);
    return NextResponse.json(
      {
        error: "in_use",
        message:
          "No se pudo eliminar — el usuario tiene actividad asociada (pedidos, turnos). Cámbialo a otro rol o desactívalo por otra vía.",
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
}
