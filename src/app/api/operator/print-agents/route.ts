import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  agentTokenTail,
  generateAgentToken,
  hashAgentToken,
} from "@/lib/print/agentAuth";

const createSchema = z.object({
  label: z.string().trim().min(1).max(80),
});

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

/**
 * POST /api/operator/print-agents
 *
 * Da de alta el programa de impresión de un PC del local y devuelve su
 * token. Es la ÚNICA vez que el token existe en claro: en la DB sólo
 * queda el SHA-256 y los últimos 4 caracteres para que la pantalla pueda
 * decir "…a9f3". Si se pierde, no hay "reenviar": se da de alta otro
 * agente y se revoca este.
 *
 * Esa asimetría es deliberada — un token que se puede volver a mostrar
 * es un token que vive en la pantalla de configuración para siempre.
 */
async function POSTHandler(req: Request) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const token = generateAgentToken();
  const agent = await db.printAgent.create({
    data: {
      restaurantId,
      label: parsed.data.label,
      tokenHash: hashAgentToken(token),
      tokenTail: agentTokenTail(token),
    },
    select: {
      id: true,
      label: true,
      tokenTail: true,
      lastSeenAt: true,
      agentVersion: true,
      lastIp: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    ok: true,
    agent: {
      ...agent,
      lastSeenAt: null,
      createdAt: agent.createdAt.toISOString(),
      revokedAt: null,
    },
    // Se muestra una vez y no se vuelve a poder recuperar.
    token,
  });
}

export const POST = secureApi(POSTHandler);
