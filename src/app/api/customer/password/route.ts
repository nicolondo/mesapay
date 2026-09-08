import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import {
  createCustomerSession,
  getViewer,
  revokeAllCustomerSessions,
} from "@/lib/customerSession";

const schema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(120),
});

/**
 * POST /api/customer/password — cambio de contraseña del comensal.
 *
 * Al cambiar la clave se revocan TODAS las sesiones y se abre una nueva
 * para este dispositivo. Es la promesa que un JWT eterno no puede cumplir:
 * "cambié la contraseña" tiene que sacar de la cuenta al celular que se
 * perdió, no solo pedir una clave nueva la próxima vez.
 */
export async function POST(req: Request) {
  const viewer = await getViewer();
  if (!viewer) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const user = await db.user.findUnique({
    where: { id: viewer.id },
    select: { id: true, passwordHash: true },
  });
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ok = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "wrong_password" }, { status: 400 });
  }

  // Mismo mecanismo de hashing que el resto del repo.
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  await db.user.update({ where: { id: user.id }, data: { passwordHash } });

  // Primero mata todo (incluida la de este dispositivo), después abre una
  // limpia acá. En ese orden no queda ninguna sesión vieja viva.
  await revokeAllCustomerSessions(user.id);
  await createCustomerSession(user.id, req.headers.get("user-agent"));

  return NextResponse.json({ ok: true });
}
