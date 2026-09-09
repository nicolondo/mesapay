import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import {
  createDinerSession,
  revokeAllDinerSessions,
} from "@/lib/dinerSession";
import { requireTenantDiner } from "@/lib/dinerTenant";

const schema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(120),
});

/**
 * POST /api/tenant/[slug]/diner/password — cambio de contraseña del
 * comensal en ese comercio.
 *
 * Al cambiar la clave se revocan TODAS las sesiones y se abre una nueva
 * para este dispositivo. Es la promesa que un JWT eterno no puede cumplir:
 * "cambié la contraseña" tiene que sacar de la cuenta al celular que se
 * perdió, no solo pedir una clave nueva la próxima vez.
 */
async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const ctx = await requireTenantDiner(slug);
  if (!ctx) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const diner = await db.diner.findUnique({
    where: { id: ctx.diner.id },
    select: { id: true, restaurantId: true, passwordHash: true },
  });
  if (!diner) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ok = await bcrypt.compare(
    parsed.data.currentPassword,
    diner.passwordHash,
  );
  if (!ok) {
    return NextResponse.json({ error: "wrong_password" }, { status: 400 });
  }

  // Mismo mecanismo de hashing que el resto del repo.
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 10);
  await db.diner.update({ where: { id: diner.id }, data: { passwordHash } });

  // Primero mata todo (incluida la de este dispositivo), después abre una
  // limpia acá. En ese orden no queda ninguna sesión vieja viva.
  await revokeAllDinerSessions(diner.id);
  await createDinerSession(diner, req.headers.get("user-agent"));

  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
