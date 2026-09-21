/**
 * Capa de DATOS del reporte de comisiones: la única que toca Prisma.
 * Devuelve `CommissionRow` listas para `waiterCommissions.ts`; no agrupa
 * ni suma nada.
 *
 * Fuente: cuentas PAGADAS con la comisión SELLADA (`commissionSealedAt`
 * no nulo) cuyo `paidAt` cae en el período — por FECHA DE PAGO, con el
 * convenio UTC del resto del ERP (`period.ts`: `desde` a las 00:00Z,
 * `hasta` exclusivo a las 00:00Z del día siguiente). Lo que se reporta es
 * lo que quedó sellado al cobrar: acá NO se recalcula con el % de hoy.
 *
 * Una cuenta cuyo mesero fue borrado (FK `SET NULL`) pierde el nombre y se
 * omite: sin persona no hay a quién liquidarle. Desactivar (`disabledAt`)
 * no borra nada, y es el camino normal.
 */
import { db } from "@/lib/db";
import type { CommissionRow } from "@/lib/waiterCommissions";
import { periodToUtcRange, type ReportPeriod } from "./period";

export async function loadSealedCommissions(
  restaurantId: string,
  period: ReportPeriod,
  opts: { waiterId?: string } = {},
): Promise<CommissionRow[]> {
  const { from, to } = periodToUtcRange(period);
  const orders = await db.order.findMany({
    where: {
      restaurantId,
      status: "paid",
      commissionSealedAt: { not: null },
      paidAt: { gte: from, lt: to },
      ...(opts.waiterId ? { commissionWaiterId: opts.waiterId } : {}),
    },
    select: {
      id: true,
      shortCode: true,
      paidAt: true,
      orderType: true,
      commissionWaiterId: true,
      commissionBps: true,
      commissionBaseCents: true,
      commissionCents: true,
      table: { select: { number: true, label: true } },
      commissionWaiter: { select: { name: true, email: true } },
    },
    orderBy: { paidAt: "asc" },
  });
  const rows: CommissionRow[] = [];
  for (const o of orders) {
    if (
      !o.paidAt ||
      o.commissionWaiterId == null ||
      o.commissionBps == null ||
      o.commissionBaseCents == null ||
      o.commissionCents == null
    ) {
      continue;
    }
    const w = o.commissionWaiter;
    rows.push({
      orderId: o.id,
      shortCode: o.shortCode,
      paidAt: o.paidAt.toISOString(),
      orderType: o.orderType,
      tableNumber: o.table?.number ?? null,
      tableLabel: o.table?.label ?? null,
      waiterId: o.commissionWaiterId,
      waiterName: w?.name?.trim() || w?.email || o.commissionWaiterId,
      bps: o.commissionBps,
      baseCents: o.commissionBaseCents,
      commissionCents: o.commissionCents,
    });
  }
  return rows;
}
