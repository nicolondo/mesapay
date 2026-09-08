import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { createCustomerSession } from "@/lib/customerSession";
import { resolveLoginIdentifier } from "@/lib/customerIdentity";

/**
 * POST /api/customer/login — inicio de sesión del comensal con CÉDULA O
 * CORREO + contraseña. Un solo campo: el `@` decide cuál es cuál.
 *
 * Solo abre sesión permanente a role=customer. El staff sigue entrando por
 * /signin con NextAuth: una sesión que no vence tiene sentido para el
 * comensal, no para una caja registradora compartida.
 */
const schema = z.object({
  identifier: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const id = resolveLoginIdentifier(parsed.data.identifier);
  if (id.kind === "invalid") {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const user = await db.user.findUnique({
    where: id.kind === "email" ? { email: id.value } : { cedula: id.value },
    select: {
      id: true,
      passwordHash: true,
      role: true,
      disabledAt: true,
    },
  });

  // Respuesta idéntica exista o no el usuario — no regalamos un oráculo de
  // "esta cédula está registrada acá".
  if (!user || user.disabledAt || user.role !== "customer") {
    // Se compara igual contra un hash falso para no filtrar por tiempo si
    // el correo existe o no.
    await bcrypt.compare(parsed.data.password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv");
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  await createCustomerSession(user.id, req.headers.get("user-agent"));
  return NextResponse.json({ ok: true });
}
