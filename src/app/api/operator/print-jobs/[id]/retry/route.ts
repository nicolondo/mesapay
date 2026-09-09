import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

/**
 * POST /api/operator/print-jobs/{id}/retry
 *
 * Reimprimir a propósito. El PR de la cola dejó anotado que no existía:
 * si una comanda se perdía (impresora sin papel, PC apagado, los cinco
 * intentos quemados) no había forma de volver a mandarla y alguien tenía
 * que cantársela a la cocina de memoria.
 *
 * ── Por qué CLONA en vez de revivir la fila ─────────────────────────────
 * Un trabajo sólo se entrega si `createdAt` está dentro de JOB_TTL_MS (6
 * horas): reciclar la fila vieja habría dejado el botón sin efecto justo
 * en el caso que más importa, el de la comanda de anoche. Además el
 * trabajo original es el registro de lo que pasó — que se entregó cinco
 * veces y falló es información, no basura que haya que pisar.
 *
 * El clon va con `dedupeKey: null`: la clave de idempotencia existe para
 * que el KDS no encole cinco copias de la misma ronda, no para impedir
 * que un humano pida a propósito otra copia.
 *
 * El payload se copia tal cual y los bytes se renderizan al entregar, así
 * que la reimpresión sale con el renderer ACTUAL — un arreglo de corte de
 * línea o de code page también arregla las reimpresiones.
 */
export async function POST(
  _req: Request,
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

  const job = await db.printJob.findFirst({
    where: { id, restaurantId },
    select: {
      id: true,
      printerId: true,
      kind: true,
      payload: true,
      orderId: true,
      roundId: true,
      printer: { select: { active: true } },
    },
  });
  // 404 y no 403 cuando el trabajo es de otro comercio: no se confirma ni
  // la existencia de recursos ajenos.
  if (!job) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // Contra una impresora apagada el clon se encolaría y nunca se
  // entregaría (`claimableWhere` exige printer.active). Mejor decirlo
  // ahora que dejar al operador esperando papel.
  if (!job.printer.active) {
    return NextResponse.json({ error: "printer_inactive" }, { status: 409 });
  }

  const clone = await db.printJob.create({
    data: {
      restaurantId,
      printerId: job.printerId,
      kind: job.kind,
      payload: job.payload as object,
      orderId: job.orderId,
      roundId: job.roundId,
      dedupeKey: null,
    },
    select: { id: true, status: true, createdAt: true },
  });

  return NextResponse.json(
    {
      ok: true,
      job: { ...clone, createdAt: clone.createdAt.toISOString() },
      retriedFrom: job.id,
    },
    { status: 202 },
  );
}
