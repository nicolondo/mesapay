import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { createDinerSession } from "@/lib/dinerSession";
import { resolveTenantId } from "@/lib/dinerTenant";
import { resolveLoginIdentifier } from "@/lib/customerIdentity";

/**
 * POST /api/tenant/[slug]/diner/login — inicio de sesión del comensal EN
 * ESE COMERCIO, con CÉDULA O CORREO + contraseña. Un solo campo: el `@`
 * decide cuál es cuál.
 *
 * La cuenta se busca por (restaurantId, correo|cédula): una cuenta del
 * restaurante A no abre sesión en el B, ni aunque la persona tenga el mismo
 * correo en los dos.
 *
 * El personal sigue entrando por /signin con NextAuth: una sesión que no
 * vence tiene sentido para el comensal, no para una caja registradora
 * compartida.
 */
const schema = z.object({
  identifier: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(200),
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
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const id = resolveLoginIdentifier(parsed.data.identifier);
  if (id.kind === "invalid") {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const diner = await db.diner.findUnique({
    where:
      id.kind === "email"
        ? { restaurantId_email: { restaurantId, email: id.value } }
        : { restaurantId_cedula: { restaurantId, cedula: id.value } },
    select: {
      id: true,
      restaurantId: true,
      passwordHash: true,
      disabledAt: true,
    },
  });

  // Respuesta idéntica exista o no la cuenta — no regalamos un oráculo de
  // "esta cédula está registrada acá".
  if (!diner || diner.disabledAt) {
    // Se compara igual contra un hash falso para no filtrar por tiempo si
    // el correo existe o no.
    await bcrypt.compare(
      parsed.data.password,
      "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv",
    );
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const ok = await bcrypt.compare(parsed.data.password, diner.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  await createDinerSession(diner, req.headers.get("user-agent"));
  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
