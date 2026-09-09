import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
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
async function POSTHandler(req: Request) {
  const secret = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const summary = await sweepUnconsumedOrders();
  await db.rateLimitBucket.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  await db.platformEvent.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * 86400_000) } } });
  // A process can die after the provider accepts, before the local result commits.
  const staleAt = new Date(Date.now() - 30 * 60_000);
  const operations = await db.financialOperation.findMany({ where: { status: "pending", createdAt: { lt: staleAt } }, select: { key: true, paymentId: true }, take: 500 });
  await db.$transaction(async tx => {
    await tx.financialOperation.updateMany({ where: { key: { in: operations.map(o => o.key) }, status: "pending" }, data: { status: "uncertain" } });
    await tx.payment.updateMany({ where: {
      OR: [
        { id: { in: operations.map(o => o.paymentId) }, refundReservedCents: { gt: 0 } },
        { status: "pending", method: { in: ["kushki_card", "kushki_apple_pay", "kushki_card_terminal", "kushki_pse"] }, createdAt: { lt: staleAt } },
      ],
    }, data: { reconciliationRequired: true } });
  });
  const reconciliationRequired = await db.payment.count({ where: { reconciliationRequired: true } });
  return NextResponse.json({ ...summary, reconciliationRequired });
}

export const POST = secureApi(POSTHandler);
