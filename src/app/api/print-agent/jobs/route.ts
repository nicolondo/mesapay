import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseTicketPayload, renderTicket } from "@/lib/escpos";
import {
  authenticatePrintAgent,
  clientIp,
  touchPrintAgent,
} from "@/lib/print/agentAuth";
import {
  MAX_ATTEMPTS,
  claimableWhere,
  normalizeLimit,
  selectClaimable,
} from "@/lib/print/claim";

export const dynamic = "force-dynamic";

/**
 * GET /api/print-agent/jobs?limit=10
 *
 * El agente de impresión (servicio de Windows en un PC del local) pide
 * los trabajos pendientes de SU restaurante. Devuelve los bytes ESC/POS
 * ya renderizados en base64 + la IP y el puerto de la impresora: el
 * agente sólo abre el socket y escribe. Es un puente tonto a propósito —
 * cambiar el diseño de la comanda no obliga a actualizar el .exe de cada
 * cocina.
 *
 * Va FUERA de /operator/ porque esas rutas exigen sesión de staff; acá la
 * identidad es el token Bearer del agente.
 *
 * Los trabajos devueltos quedan `delivered`. Uno que se entregó y nunca
 * se confirmó vuelve a entregarse pasados CLAIM_RETRY_MS (el PC se pudo
 * apagar entre "lo recibí" y "lo imprimí").
 */
export async function GET(req: Request) {
  const agent = await authenticatePrintAgent(req);
  if (!agent) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const limit = normalizeLimit(new URL(req.url).searchParams.get("limit"));

  // Pedir trabajos es señal de vida: no hace falta esperar al latido.
  await touchPrintAgent(agent.agentId, { ip: clientIp(req) });

  // Los que ya agotaron los intentos se cierran acá, no se entregan más.
  await db.printJob.updateMany({
    where: {
      restaurantId: agent.restaurantId,
      status: { in: ["pending", "delivered"] },
      attempts: { gte: MAX_ATTEMPTS },
    },
    data: { status: "failed", failedAt: now, lastError: "max_attempts" },
  });

  const rows = await db.printJob.findMany({
    where: claimableWhere(agent.restaurantId, now),
    orderBy: { createdAt: "asc" },
    take: limit,
    select: {
      id: true,
      restaurantId: true,
      status: true,
      attempts: true,
      createdAt: true,
      deliveredAt: true,
      nextAttemptAt: true,
      kind: true,
      payload: true,
      orderId: true,
      roundId: true,
      printer: {
        select: { id: true, label: true, host: true, port: true },
      },
    },
  });

  // Cinturón y tirantes: se vuelve a aplicar el filtro en memoria para
  // que la garantía multi-tenant no dependa del `where` de arriba.
  const claimable = selectClaimable(rows, agent.restaurantId, now, limit);

  const jobs: Array<{
    id: string;
    kind: string;
    attempt: number;
    createdAt: string;
    orderId: string | null;
    roundId: string | null;
    printer: { id: string; label: string; host: string; port: number };
    data: string;
    bytes: number;
  }> = [];

  for (const job of claimable) {
    const row = rows.find((r) => r.id === job.id)!;
    const ticket = parseTicketPayload(row.payload);
    if (!ticket) {
      // Payload corrupto o de una versión que este servidor ya no sabe
      // renderizar: se cierra en fallido en vez de trabar la cola.
      await db.printJob.updateMany({
        where: { id: job.id, restaurantId: agent.restaurantId },
        data: { status: "failed", failedAt: now, lastError: "invalid_payload" },
      });
      continue;
    }

    // Se marca ENTREGADO antes de devolverlo, con el estado leído como
    // condición: `attempts` sube en cada entrega, así que sirve de
    // número de versión. Si otro agente del mismo local se lo llevó
    // entremedio, este UPDATE no toca ninguna fila y el trabajo no se
    // entrega dos veces — que en una cocina sería una comanda repetida.
    const claimed = await db.printJob.updateMany({
      where: {
        id: job.id,
        restaurantId: agent.restaurantId,
        status: job.status,
        attempts: job.attempts,
      },
      data: {
        status: "delivered",
        deliveredAt: now,
        nextAttemptAt: null,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) continue;

    const bytes = renderTicket(ticket);
    jobs.push({
      id: job.id,
      kind: row.kind,
      attempt: job.attempts + 1,
      createdAt: job.createdAt.toISOString(),
      orderId: row.orderId,
      roundId: row.roundId,
      printer: row.printer,
      data: bytes.toString("base64"),
      bytes: bytes.length,
    });
  }

  return NextResponse.json({
    agent: { id: agent.agentId, label: agent.label },
    serverTime: now.toISOString(),
    jobs,
  });
}
