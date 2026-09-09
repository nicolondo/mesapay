import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const patchSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  /** true = revocar. No hay "des-revocar": un token filtrado no vuelve. */
  revoked: z.literal(true).optional(),
});

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

/**
 * PATCH /api/operator/print-agents/{id}
 * body: { label } | { revoked: true }
 *
 * Revocar es destructivo de verdad: ese PC deja de autenticar y, por lo
 * tanto, deja de imprimir. No se borra la fila — los PrintJob que pasaron
 * por él son el historial que contesta "¿esta comanda salió?".
 *
 * Sus impresoras se apagan junto con él: si el agente no puede pedir
 * trabajos, dejarlas activas sólo lograría que las comandas se encolen
 * hacia una impresora que ya nadie va a atender.
 */
async function PATCHHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const { id } = await params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const agent = await db.printAgent.findFirst({
    where: { id, restaurantId },
    select: { id: true, revokedAt: true },
  });
  if (!agent) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const revoking = parsed.data.revoked === true && !agent.revokedAt;
  const updated = await db.printAgent.update({
    where: { id: agent.id },
    data: {
      ...(parsed.data.label !== undefined && { label: parsed.data.label }),
      ...(revoking && { revokedAt: new Date() }),
    },
    select: {
      id: true,
      label: true,
      tokenTail: true,
      lastSeenAt: true,
      agentVersion: true,
      lastIp: true,
      revokedAt: true,
    },
  });

  if (revoking) {
    await db.printer.updateMany({
      where: { agentId: agent.id, restaurantId },
      data: { active: false },
    });
  }

  return NextResponse.json({
    ok: true,
    agent: {
      ...updated,
      lastSeenAt: updated.lastSeenAt?.toISOString() ?? null,
      revokedAt: updated.revokedAt?.toISOString() ?? null,
    },
  });
}

export const PATCH = secureApi(PATCHHandler);
