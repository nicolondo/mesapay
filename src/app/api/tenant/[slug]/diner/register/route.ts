import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { sendWelcomeEmail } from "@/lib/mailer";
import { createDinerSession } from "@/lib/dinerSession";
import { resolveTenantId } from "@/lib/dinerTenant";
import {
  normalizeCedula,
  isValidCedula,
  CEDULA_MAX_LEN,
} from "@/lib/customerIdentity";

/**
 * POST /api/tenant/[slug]/diner/register — crea la cuenta del comensal EN
 * ESE COMERCIO.
 *
 * El restaurante sale del slug de la URL, nunca del cuerpo: si el cliente
 * pudiera elegirlo, cualquiera podría sembrar cuentas en la base de otro
 * local.
 *
 * Correo y cédula son únicos DENTRO del comercio. La misma persona que come
 * en dos restaurantes MESAPAY se registra dos veces — decisión de producto
 * asumida: su descuento y su historial no la siguen entre locales.
 *
 * Los mensajes de error son CÓDIGOS estables, no texto: la app es trilingüe
 * y el copy lo pone el cliente con su catálogo (ver AGENTS.md).
 */
const schema = z.object({
  name: z.string().trim().min(2).max(80),
  cedula: z.string().trim().min(1).max(40),
  email: z.string().email(),
  password: z.string().min(8).max(120),
  phone: z
    .string()
    .trim()
    .min(6)
    .max(24)
    .regex(/^[+\d][\d\s().-]*$/)
    .optional(),
  marketingOptIn: z.boolean().optional(),
});

async function POSTHandler(
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
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();
  // Se guarda la forma canónica: "1.020.304" y "1020304" son la MISMA
  // persona, y sin esto el UNIQUE dejaría crear dos cuentas por documento.
  const cedula = normalizeCedula(parsed.data.cedula);
  if (!isValidCedula(cedula) || cedula.length > CEDULA_MAX_LEN) {
    return NextResponse.json({ error: "invalid_cedula" }, { status: 400 });
  }

  const [emailTaken, cedulaTaken] = await Promise.all([
    db.diner.findUnique({
      where: { restaurantId_email: { restaurantId, email } },
      select: { id: true },
    }),
    db.diner.findUnique({
      where: { restaurantId_cedula: { restaurantId, cedula } },
      select: { id: true },
    }),
  ]);
  if (emailTaken) {
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }
  if (cedulaTaken) {
    return NextResponse.json({ error: "cedula_taken" }, { status: 409 });
  }

  // Mismo mecanismo de hashing que ya usa todo el repo para passwordHash.
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);

  let diner;
  try {
    diner = await db.diner.create({
      data: {
        restaurantId,
        email,
        cedula,
        name: parsed.data.name,
        phone: parsed.data.phone,
        passwordHash,
        marketingOptIn: parsed.data.marketingOptIn ?? false,
      },
      select: { id: true, restaurantId: true, email: true, name: true },
    });
  } catch {
    // Carrera entre el chequeo de arriba y el INSERT: dos pestañas
    // registrando el mismo correo/cédula al tiempo. El UNIQUE es la
    // defensa real; acá solo lo traducimos a un 409 entendible.
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }

  // Sesión permanente PERO revocable (fila en DB, no JWT eterno): el
  // comensal no vuelve a ver un login, y nosotros podemos matarla.
  await createDinerSession(diner, req.headers.get("user-agent"));

  const locale = await getLocale();
  const sent = await sendWelcomeEmail(
    { email: diner.email, name: diner.name },
    locale,
    // El botón del correo lleva a la cuenta EN ESTE comercio, no a un "/me"
    // global que ya no existe.
    `${process.env.NEXTAUTH_URL ?? "https://mesapay.co"}/t/${slug}/cuenta`,
  );
  if (sent) {
    await db.diner.update({
      where: { id: diner.id },
      data: { welcomedAt: new Date() },
    });
  }

  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
