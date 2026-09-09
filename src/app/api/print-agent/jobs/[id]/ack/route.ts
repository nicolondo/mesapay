import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  authenticatePrintAgent,
  clientIp,
  touchPrintAgent,
} from "@/lib/print/agentAuth";
import {
  MAX_ATTEMPTS,
  retryBackoffMs,
  shouldRetryAfterFailure,
} from "@/lib/print/claim";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  ok: z.boolean(),
  /** Motivo del fallo, tal cual lo vio el agente ("ECONNREFUSED …"). */
  error: z.string().max(500).optional(),
});

/**
 * POST /api/print-agent/jobs/{id}/ack
 * body: { ok: true } | { ok: false, error: "ECONNREFUSED 192.168.1.50:9100" }
 *
 * Acuse del agente: la comanda salió por la impresora, o no salió y por
 * qué. Sin esto no habría forma de saber que un ticket se perdió — que
 * es justamente el agujero del esquema viejo con la pestaña de Chrome,
 * donde los errores se tragaban con un `catch {}` vacío.
 *
 * Un fallo deja rastro (`lastError`) y vuelve a `pending` para otro
 * intento, hasta MAX_ATTEMPTS. Ahí se cierra en `failed`: un ticket que
 * rompe la impresora no se puede reintentar mil veces.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const agent = await authenticatePrintAgent(req);
  if (!agent) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  await touchPrintAgent(agent.agentId, { ip: clientIp(req) });

  const job = await db.printJob.findUnique({
    where: { id },
    select: { id: true, restaurantId: true, status: true, attempts: true },
  });
  // 404 y no 403 cuando el trabajo es de otro restaurante: un token no
  // debe poder ni siquiera confirmar la EXISTENCIA de trabajos ajenos.
  if (!job || job.restaurantId !== agent.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const now = new Date();

  if (parsed.data.ok) {
    await db.printJob.update({
      where: { id: job.id },
      data: {
        status: "printed",
        printedAt: now,
        lastError: null,
        nextAttemptAt: null,
      },
    });
    return NextResponse.json({ status: "printed" });
  }

  const willRetry = shouldRetryAfterFailure(job.attempts);
  const nextAttemptAt = willRetry
    ? new Date(now.getTime() + retryBackoffMs(job.attempts))
    : null;
  await db.printJob.update({
    where: { id: job.id },
    data: {
      status: willRetry ? "pending" : "failed",
      lastError: parsed.data.error?.slice(0, 500) ?? "unknown_error",
      nextAttemptAt,
      ...(willRetry ? {} : { failedAt: now }),
    },
  });
  return NextResponse.json({
    status: willRetry ? "pending" : "failed",
    willRetry,
    attempts: job.attempts,
    maxAttempts: MAX_ATTEMPTS,
    retryAfter: nextAttemptAt?.toISOString() ?? null,
  });
}
