import { NextResponse } from "next/server";
import { revokeCurrentCustomerSession } from "@/lib/customerSession";

/**
 * POST /api/customer/logout — cierra la sesión de ESTE dispositivo.
 *
 * Revoca la fila en DB además de borrar la cookie: si solo borráramos la
 * cookie, una copia del token (extensión, backup del navegador) seguiría
 * abriendo la cuenta.
 */
export async function POST() {
  await revokeCurrentCustomerSession();
  return NextResponse.json({ ok: true });
}
