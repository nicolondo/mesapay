import { NextResponse } from "next/server";
import {
  revokeAllDinerSessions,
  revokeCurrentDinerSession,
} from "@/lib/dinerSession";
import { requireTenantDiner } from "@/lib/dinerTenant";

/**
 * DELETE /api/tenant/[slug]/diner/sessions — "cerrar sesión en todos los
 * dispositivos".
 *
 * Esta es la razón de ser de la sesión contra base de datos. Con un JWT
 * eterno este botón no podría existir: el servidor no tiene forma de
 * invalidar un token que nunca consulta. Acá es un UPDATE.
 *
 * Body `{ keepCurrent: true }` deja viva la sesión de este dispositivo
 * (caso "perdí el celular, pero sigo en mi computador").
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const ctx = await requireTenantDiner(slug);
  if (!ctx) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const keepCurrent = body?.keepCurrent === true;

  const revoked = await revokeAllDinerSessions(
    ctx.diner.id,
    keepCurrent ? ctx.diner.sessionId : null,
  );

  // Si además se cierra la actual, hay que soltar la cookie de este
  // navegador — la fila ya quedó revocada arriba, pero la cookie muerta
  // solo estorba.
  if (!keepCurrent) {
    await revokeCurrentDinerSession(ctx.restaurantId);
  }

  return NextResponse.json({ ok: true, revoked });
}
