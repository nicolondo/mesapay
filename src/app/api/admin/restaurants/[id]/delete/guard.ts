import { NextResponse } from "next/server";
import { auth } from "@/auth";

/**
 * Sólo platform_admin, verificado contra la sesión del servidor. El rol sale
 * del JWT revalidado contra la base (src/auth.ts) e impersonar NO lo cambia:
 * un group_admin u operador "dentro" de un comercio sigue sin poder borrarlo
 * ni resolver sus bloqueos. Lo comparten la ruta del borrado y la de acciones.
 */
export async function requirePlatformAdmin() {
  const session = await auth();
  if (!session?.user) return { denied: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (session.user.role !== "platform_admin") {
    return { denied: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { session };
}
