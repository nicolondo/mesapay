import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { sendWelcomeEmail } from "@/lib/mailer";

const schema = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1).max(80).optional(),
  phone: z
    .string()
    .trim()
    .min(6)
    .max(24)
    .regex(/^[+\d][\d\s().-]*$/, "teléfono inválido")
    .optional(),
  password: z.string().min(6).max(120),
  marketingOptIn: z.boolean().optional(),
});

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  }
  const email = parsed.data.email.toLowerCase();
  const exists = await db.user.findUnique({ where: { email } });
  if (exists) {
    return NextResponse.json({ error: "Ya existe una cuenta con ese correo" }, { status: 409 });
  }
  const passwordHash = await bcrypt.hash(parsed.data.password, 10);
  const user = await db.user.create({
    data: {
      email,
      name: parsed.data.name,
      phone: parsed.data.phone,
      passwordHash,
      role: "customer",
      marketingOptIn: parsed.data.marketingOptIn ?? false,
    },
  });

  const sent = await sendWelcomeEmail({ email: user.email, name: user.name });
  if (sent) {
    await db.user.update({
      where: { id: user.id },
      data: { welcomedAt: new Date() },
    });
  }

  return NextResponse.json({ ok: true, id: user.id });
}
