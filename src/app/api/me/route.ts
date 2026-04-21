import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";

const schema = z.object({
  name: z.string().trim().min(1).max(80).nullable().optional(),
  phone: z
    .string()
    .trim()
    .min(6)
    .max(24)
    .regex(/^[+\d][\d\s().-]*$/, "teléfono inválido")
    .nullable()
    .optional(),
  marketingOptIn: z.boolean().optional(),
});

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  }
  await db.user.update({
    where: { id: session.user.id },
    data: {
      name: parsed.data.name ?? null,
      phone: parsed.data.phone ?? null,
      marketingOptIn: parsed.data.marketingOptIn ?? false,
    },
  });
  return NextResponse.json({ ok: true });
}
