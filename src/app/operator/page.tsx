import Link from "next/link";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function OperatorHome() {
  const session = await auth();
  const restaurantId = session!.user!.restaurantId;
  if (!restaurantId) {
    return (
      <div className="p-8">
        <p>No tienes restaurante asignado. Contacta al admin.</p>
      </div>
    );
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [openOrders, todayPaid, todayPaidAgg] = await Promise.all([
    db.order.count({
      where: {
        restaurantId,
        status: { in: ["placed", "in_kitchen", "ready", "served", "paying"] },
      },
    }),
    db.order.count({
      where: { restaurantId, status: "paid", paidAt: { gte: today } },
    }),
    db.order.aggregate({
      where: { restaurantId, status: "paid", paidAt: { gte: today } },
      _sum: { totalCents: true },
    }),
  ]);

  const recentOrders = await db.order.findMany({
    where: { restaurantId },
    orderBy: { updatedAt: "desc" },
    take: 12,
    include: { table: true },
  });

  return (
    <div className="p-6 max-w-6xl mx-auto w-full">
      <div className="grid grid-cols-3 gap-4">
        <Kpi label="Órdenes abiertas" value={String(openOrders)} />
        <Kpi label="Órdenes pagadas hoy" value={String(todayPaid)} />
        <Kpi
          label="Ventas hoy"
          value={fmtCOP(todayPaidAgg._sum.totalCents ?? 0)}
        />
      </div>

      <div className="mt-8 bg-op-surface border border-op-border rounded-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-op-border">
          <div className="font-display text-xl">Últimas órdenes</div>
          <Link href="/operator/kitchen" className="text-sm text-terracotta">
            Ir a cocina →
          </Link>
        </div>
        <ul className="divide-y divide-op-border">
          {recentOrders.map((o) => (
            <li key={o.id} className="flex items-center justify-between px-5 py-3">
              <div>
                <div className="font-mono text-sm">{o.shortCode}</div>
                <div className="text-xs text-op-muted">
                  Mesa {o.table.number} · {o.status}
                </div>
              </div>
              <div className="font-mono tabular text-sm">{fmtCOP(o.totalCents)}</div>
            </li>
          ))}
          {recentOrders.length === 0 && (
            <li className="px-5 py-6 text-sm text-op-muted">
              Aún no hay órdenes. Escanea un QR o abre una mesa.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-op-surface border border-op-border rounded-2xl p-4">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div className="font-display text-3xl mt-1 tracking-[-0.015em]">{value}</div>
    </div>
  );
}
