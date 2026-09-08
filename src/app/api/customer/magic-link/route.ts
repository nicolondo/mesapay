import { NextResponse } from "next/server";
import { z } from "zod";
import { getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { sendMagicLinkEmail } from "@/lib/mailer";
import { resolveLoginIdentifier } from "@/lib/customerIdentity";
import {
  generateMagicLinkToken,
  hashMagicLinkToken,
  MAGIC_LINK_TTL_MS,
} from "@/lib/magicLink";

const BASE_URL = process.env.NEXTAUTH_URL ?? "https://mesapay.co";

const schema = z.object({
  identifier: z.string().trim().min(1).max(120),
});

/**
 * POST /api/customer/magic-link — manda por correo un enlace de acceso
 * directo. Acepta cédula o correo (si es cédula, el enlace va al correo
 * registrado en esa cuenta).
 *
 * SIEMPRE responde ok, exista o no la cuenta. Si respondiéramos 404 cuando
 * no existe, este endpoint sería un buscador público de "¿esta cédula tiene
 * cuenta en MESAPAY?" — mismo criterio que el flujo de restablecimiento.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: true });

  const id = resolveLoginIdentifier(parsed.data.identifier);
  if (id.kind === "invalid") return NextResponse.json({ ok: true });

  const user = await db.user.findUnique({
    where: id.kind === "email" ? { email: id.value } : { cedula: id.value },
    select: { id: true, email: true, name: true, role: true, disabledAt: true },
  });
  if (!user || user.disabledAt || user.role !== "customer") {
    return NextResponse.json({ ok: true });
  }

  const token = generateMagicLinkToken();
  await db.$transaction([
    // Invalida enlaces anteriores del mismo usuario: pedir uno nuevo
    // tiene que matar el viejo, si no cada solicitud deja otra llave viva.
    db.magicLinkToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    }),
    db.magicLinkToken.create({
      data: {
        tokenHash: hashMagicLinkToken(token),
        userId: user.id,
        expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
      },
    }),
  ]);

  await sendMagicLinkEmail(
    { email: user.email, name: user.name },
    `${BASE_URL}/cuenta/enlace/${token}`,
    await getLocale(),
  );

  return NextResponse.json({ ok: true });
}
