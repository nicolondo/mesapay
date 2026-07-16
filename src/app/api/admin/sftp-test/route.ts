import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { sftpConfigured, testSftpConnection } from "@/lib/sftp";

export const dynamic = "force-dynamic";

/**
 * Diagnóstico de la conexión SFTP (AWS Transfer) — solo platform_admin.
 * GET /api/admin/sftp-test → { configured, ok, error? }. Sirve para verificar
 * las credenciales sin subir un documento real. No expone la llave ni el host.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!sftpConfigured()) {
    return NextResponse.json({
      configured: false,
      ok: false,
      hint: "Faltan las variables MESAPAY_SFTP_* en el .env del server.",
    });
  }
  const result = await testSftpConnection();
  return NextResponse.json({ configured: true, ...result });
}
