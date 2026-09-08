import { NextResponse } from "next/server";
import { z } from "zod";
import { getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { sendMagicLinkEmail } from "@/lib/mailer";
import { resolveTenantId } from "@/lib/dinerTenant";
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
 * POST /api/tenant/[slug]/diner/magic-link — manda por correo un enlace de
 * acceso directo A LA CUENTA DE ESE COMERCIO. Acepta cédula o correo (si es
 * cédula, el enlace va al correo registrado en esa cuenta).
 *
 * El enlace queda atado al restaurante por partida doble: el token cuelga
 * de un `Diner`, que pertenece a un solo local, y la URL que va en el
 * correo es `/t/<slug>/cuenta/enlace/<token>`. Abrirlo en la URL de otro
 * restaurante no abre nada (ver la pantalla de canje).
 *
 * SIEMPRE responde ok, exista o no la cuenta. Si respondiéramos 404 cuando
 * no existe, este endpoint sería un buscador público de "¿esta cédula tiene
 * cuenta acá?" — mismo criterio que el flujo de restablecimiento.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const restaurantId = await resolveTenantId(slug);
  if (!restaurantId) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: true });

  const id = resolveLoginIdentifier(parsed.data.identifier);
  if (id.kind === "invalid") return NextResponse.json({ ok: true });

  const diner = await db.diner.findUnique({
    where:
      id.kind === "email"
        ? { restaurantId_email: { restaurantId, email: id.value } }
        : { restaurantId_cedula: { restaurantId, cedula: id.value } },
    select: { id: true, email: true, name: true, disabledAt: true },
  });
  if (!diner || diner.disabledAt) {
    return NextResponse.json({ ok: true });
  }

  const token = generateMagicLinkToken();
  await db.$transaction([
    // Invalida enlaces anteriores del mismo comensal: pedir uno nuevo
    // tiene que matar el viejo, si no cada solicitud deja otra llave viva.
    db.dinerMagicLink.updateMany({
      where: { dinerId: diner.id, usedAt: null },
      data: { usedAt: new Date() },
    }),
    db.dinerMagicLink.create({
      data: {
        tokenHash: hashMagicLinkToken(token),
        dinerId: diner.id,
        expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
      },
    }),
  ]);

  await sendMagicLinkEmail(
    { email: diner.email, name: diner.name },
    `${BASE_URL}/t/${slug}/cuenta/enlace/${token}`,
    await getLocale(),
  );

  return NextResponse.json({ ok: true });
}
