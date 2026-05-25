import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

/**
 * Roles que un operador puede crear/asignar dentro de su restaurante.
 *
 * Excluimos:
 *   - `platform_admin` → poder global; solo lo asigna otro platform_admin
 *     desde /admin/users.
 *   - `customer` → no es staff; los clientes nacen al hacer un pedido.
 */
const ASSIGNABLE_ROLES = [
  "operator",
  "mesero",
  "kitchen",
  "bar",
  "terminal",
] as const;

const postBody = z.object({
  email: z
    .string()
    .email("Email inválido")
    .transform((s) => s.toLowerCase().trim()),
  name: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((s) => (s && s.length > 0 ? s : undefined)),
  password: z
    .string()
    .min(6, "Mínimo 6 caracteres")
    .max(200),
  role: z.enum(ASSIGNABLE_ROLES),
});

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

/**
 * Crea un usuario staff dentro del restaurante activo. Reservado a
 * operadores (o platform_admin impersonando). El nuevo usuario queda
 * atado a `restaurantId` siempre — no creamos `platform_admin` ni
 * `customer` por acá.
 *
 * Email es global-unique en la tabla; rechazamos con 409 si ya existe
 * (incluso si pertenece a otro restaurante).
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = postBody.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: "invalid", message: first?.message ?? "Datos inválidos" },
      { status: 400 },
    );
  }

  const { email, name, password, role } = parsed.data;

  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "email_taken", message: "Ya existe un usuario con ese email" },
      { status: 409 },
    );
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await db.user.create({
    data: {
      email,
      name: name ?? null,
      passwordHash,
      role,
      restaurantId,
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      assignedTableNumbers: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ ok: true, user });
}
