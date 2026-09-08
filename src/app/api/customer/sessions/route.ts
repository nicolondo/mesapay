import { NextResponse } from "next/server";
import {
  getViewer,
  revokeAllCustomerSessions,
  revokeCurrentCustomerSession,
} from "@/lib/customerSession";

/**
 * DELETE /api/customer/sessions — "cerrar sesión en todos los dispositivos".
 *
 * Esta es la razón de ser de la sesión contra base de datos. Con un JWT
 * eterno este botón no podría existir: el servidor no tiene forma de
 * invalidar un token que nunca consulta. Acá es un UPDATE.
 *
 * Body `{ keepCurrent: true }` deja viva la sesión de este dispositivo
 * (caso "perdí el celular, pero sigo en mi computador").
 */
export async function DELETE(req: Request) {
  const viewer = await getViewer();
  if (!viewer) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  const keepCurrent = body?.keepCurrent === true;

  const revoked = await revokeAllCustomerSessions(
    viewer.id,
    keepCurrent ? viewer.sessionId : null,
  );

  // Si además se cierra la actual, hay que soltar la cookie de este
  // navegador — la fila ya quedó revocada arriba, pero la cookie muerta
  // solo estorba.
  if (!keepCurrent) {
    await revokeCurrentCustomerSession();
  }

  return NextResponse.json({ ok: true, revoked });
}
