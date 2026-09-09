import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import {
  authenticatePrintAgent,
  clientIp,
  touchPrintAgent,
} from "@/lib/print/agentAuth";
import { claimableWhere } from "@/lib/print/claim";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    /** Versión del .exe instalado, para saber a quién hay que actualizar. */
    version: z.string().max(40).optional(),
  })
  .nullable();

/**
 * POST /api/print-agent/heartbeat
 * body (opcional): { version: "1.0.3" }
 *
 * Latido. Sirve para una sola cosa, pero importante: que la pantalla de
 * configuración pueda decir "el agente de cocina no responde hace 12
 * minutos" en vez de que el dueño se entere porque un cliente reclamó
 * que su plato nunca llegó.
 *
 * De paso devuelve las impresoras configuradas y cuántos trabajos hay
 * esperando — le da al agente lo necesario para mostrar su propio estado
 * sin inventarse otra ruta.
 */
export async function POST(req: Request) {
  const agent = await authenticatePrintAgent(req);
  if (!agent) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  await touchPrintAgent(agent.agentId, {
    agentVersion: parsed.success ? (parsed.data?.version ?? null) : null,
    ip: clientIp(req),
  });

  const now = new Date();
  const [printers, pendingJobs] = await Promise.all([
    db.printer.findMany({
      where: { restaurantId: agent.restaurantId, active: true },
      orderBy: { label: "asc" },
      select: {
        id: true,
        label: true,
        host: true,
        port: true,
        // `kind` va en el eco para que el instalador pueda verificar
        // contra el servidor que la de la caja quedó como de FACTURA sin
        // tener que abrir la web.
        kind: true,
        station: true,
        barSubStation: true,
      },
    }),
    db.printJob.count({ where: claimableWhere(agent.restaurantId, now) }),
  ]);

  return NextResponse.json({
    ok: true,
    agent: { id: agent.agentId, label: agent.label },
    serverTime: now.toISOString(),
    printers,
    pendingJobs,
  });
}
