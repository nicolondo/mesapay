import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { sendWelcomeEmail } from "@/lib/mailer";
import { createCustomerSession } from "@/lib/customerSession";
import {
  normalizeCedula,
  isValidCedula,
  CEDULA_MAX_LEN,
} from "@/lib/customerIdentity";

/**
 * POST /api/customer/register — crea la cuenta del comensal.
 *
 * Pide nombre completo, cédula, correo y contraseña. La cédula queda como
 * identificador de login alterno al correo.
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

export async function POST(req: Request) {
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
    db.user.findUnique({ where: { email }, select: { id: true } }),
    db.user.findUnique({ where: { cedula }, select: { id: true } }),
  ]);
  if (emailTaken) {
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }
  if (cedulaTaken) {
    return NextResponse.json({ error: "cedula_taken" }, { status: 409 });
  }

  // Mismo mecanismo de hashing que ya usa todo el repo para passwordHash.
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);

  let user;
  try {
    user = await db.user.create({
      data: {
        email,
        cedula,
        name: parsed.data.name,
        phone: parsed.data.phone,
        passwordHash,
        role: "customer",
        marketingOptIn: parsed.data.marketingOptIn ?? false,
      },
      select: { id: true, email: true, name: true },
    });
  } catch {
    // Carrera entre el chequeo de arriba y el INSERT: dos pestañas
    // registrando el mismo correo/cédula al tiempo. El UNIQUE es la
    // defensa real; acá solo lo traducimos a un 409 entendible.
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }

  // Sesión permanente PERO revocable (fila en DB, no JWT eterno): el
  // comensal no vuelve a ver un login, y nosotros podemos matarla.
  await createCustomerSession(user.id, req.headers.get("user-agent"));

  const locale = await getLocale();
  const sent = await sendWelcomeEmail(
    { email: user.email, name: user.name },
    locale,
  );
  if (sent) {
    await db.user.update({
      where: { id: user.id },
      data: { welcomedAt: new Date() },
    });
  }

  return NextResponse.json({ ok: true });
}
