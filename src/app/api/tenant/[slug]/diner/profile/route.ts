import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireTenantDiner } from "@/lib/dinerTenant";

const schema = z.object({
  name: z.string().trim().min(1).max(80).nullable().optional(),
  phone: z
    .string()
    .trim()
    .min(6)
    .max(24)
    .regex(/^[+\d][\d\s().-]*$/)
    .nullable()
    .optional(),
  marketingOptIn: z.boolean().optional(),
});

/**
 * PATCH /api/tenant/[slug]/diner/profile — el comensal edita SU perfil en
 * ese comercio. Nombre, celular y la aceptación de marketing son de esa
 * cuenta: si la misma persona está registrada en otro restaurante, ese
 * perfil es otro y no se toca desde acá.
 */
async function PATCHHandler(
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

  await db.diner.update({
    where: { id: ctx.diner.id },
    data: {
      name: parsed.data.name ?? null,
      phone: parsed.data.phone ?? null,
      marketingOptIn: parsed.data.marketingOptIn ?? false,
    },
  });
  return NextResponse.json({ ok: true });
}

export const PATCH = secureApi(PATCHHandler);
