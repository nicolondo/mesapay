import { NextResponse } from "next/server";
import { sweepUnconsumedOrders } from "@/lib/erp/consumption";

export const dynamic = "force-dynamic";

/**
 * Cron de respaldo del consumo automático de inventario (ERP A4).
 *
 * El disparo principal es el hook de `order.paid` en el bus de eventos;
 * este barrido cubre caídas del proceso, deploys a mitad de pago y
 * cualquier path que marque la orden pagada sin publicar el evento.
 * Idempotente (claim en consumeOrderStock) — correrlo de más no duplica.
 *
 * Auth y verbo iguales a los otros crons (x-cron-secret + POST).
 */
export async function POST(req: Request) {
  const secret = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const summary = await sweepUnconsumedOrders();
  return NextResponse.json(summary);
}
