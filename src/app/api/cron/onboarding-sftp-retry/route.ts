import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deliverDocumentToSftp } from "@/lib/onboardingSftp";
import { sftpConfigured } from "@/lib/sftp";

export const dynamic = "force-dynamic";

// Máximo de reintentos por documento (evita reintentar para siempre uno roto).
const MAX_ATTEMPTS = 12;
// Tope de documentos por corrida (una conexión SFTP por doc; secuencial).
const BATCH = 25;

/**
 * Reintenta la entrega por SFTP de los documentos de onboarding que no se
 * subieron (sftpUploadedAt null). El disparo principal es fire-and-forget en
 * el upload; este cron cubre caídas del SFTP, deploys a mitad de subida, etc.
 * Idempotente (deliverDocumentToSftp saltea los ya entregados).
 *
 * Auth y verbo iguales a los otros crons (x-cron-secret + POST).
 */
export async function POST(req: Request) {
  const secret = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!sftpConfigured()) {
    return NextResponse.json({ skipped: "sftp_not_configured" });
  }

  const pending = await db.kushkiDocument.findMany({
    where: { sftpUploadedAt: null, sftpAttempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
    select: { id: true },
  });

  let delivered = 0;
  for (const d of pending) {
    await deliverDocumentToSftp(d.id);
    const after = await db.kushkiDocument.findUnique({
      where: { id: d.id },
      select: { sftpUploadedAt: true },
    });
    if (after?.sftpUploadedAt) delivered++;
  }

  return NextResponse.json({
    attempted: pending.length,
    delivered,
    failed: pending.length - delivered,
  });
}
