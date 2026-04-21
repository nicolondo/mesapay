import Link from "next/link";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { LiveRefresh } from "./LiveRefresh";

export const dynamic = "force-dynamic";

export default async function OperatorHome() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return (
      <div className="p-8">
        <p>No tienes restaurante asignado. Contacta al admin.</p>
      </div>
    );
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { slug: true },
  });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - 6);

  const [
    openOrdersCount,
    todayPaidCount,
    todayPaidAgg,
    weekPaid,
    topItemsRaw,
    openOrders,
  ] = await Promise.all([
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
      _avg: { totalCents: true },
    }),
    db.order.findMany({
      where: {
        restaurantId,
        status: "paid",
        paidAt: { gte: weekStart },
      },
      select: { totalCents: true, paidAt: true },
    }),
    db.orderItem.groupBy({
      by: ["nameSnapshot"],
      where: {
        order: { restaurantId, status: "paid", paidAt: { gte: today } },
      },
      _sum: { qty: true },
      orderBy: { _sum: { qty: "desc" } },
      take: 5,
    }),
    db.order.findMany({
      where: {
        restaurantId,
        status: { in: ["placed", "in_kitchen", "ready", "served", "paying"] },
      },
      orderBy: { createdAt: "asc" },
      take: 10,
      include: { table: true, items: true },
    }),
  ]);

  const avgTicketCents = Math.round(todayPaidAgg._avg.totalCents ?? 0);
  const salesTodayCents = todayPaidAgg._sum.totalCents ?? 0;

  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return { date: d, cents: 0 };
  });
  for (const p of weekPaid) {
    if (!p.paidAt) continue;
    const idx = Math.floor(
      (new Date(p.paidAt).getTime() - weekStart.getTime()) / 86400000,
    );
    if (idx >= 0 && idx < 7) weekDays[idx].cents += p.totalCents;
  }
  const maxDay = Math.max(1, ...weekDays.map((d) => d.cents));

  return (
    <div className="p-6 max-w-6xl mx-auto w-full">
      {tenant?.slug && <LiveRefresh tenantSlug={tenant.slug} />}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="Ventas hoy" value={fmtCOP(salesTodayCents)} />
        <Kpi label="Órdenes pagadas" value={String(todayPaidCount)} />
        <Kpi
          label="Ticket promedio"
          value={todayPaidCount === 0 ? "—" : fmtCOP(avgTicketCents)}
        />
        <Kpi
          label="Abiertas ahora"
          value={String(openOrdersCount)}
          accent={openOrdersCount > 0}
        />
      </div>

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-op-surface border border-op-border rounded-2xl p-5">
          <div className="flex items-baseline justify-between">
            <div className="font-display text-xl">Últimos 7 días</div>
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
              {fmtCOP(weekDays.reduce((s, d) => s + d.cents, 0))}
            </div>
          </div>
          <div className="mt-5 flex items-end gap-2 h-32">
            {weekDays.map((d, i) => {
              const h = Math.max(3, Math.round((d.cents / maxDay) * 100));
              const isToday = i === weekDays.length - 1;
              return (
                <div key={i} className="flex-1 flex flex-col items-center gap-1">
                  <div
                    className={
                      "w-full rounded-t " +
                      (isToday ? "bg-terracotta" : "bg-ink/70")
                    }
                    style={{ height: `${h}%` }}
                    title={fmtCOP(d.cents)}
                  />
                  <div className="font-mono text-[9px] text-op-muted">
                    {dayLabel(d.date)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bg-op-surface border border-op-border rounded-2xl p-5">
          <div className="flex items-baseline justify-between">
            <div className="font-display text-xl">Top platos hoy</div>
            <Link href="/operator/menu" className="text-xs text-terracotta">
              Ver menú →
            </Link>
          </div>
          <ul className="mt-3 divide-y divide-op-border">
            {topItemsRaw.length === 0 && (
              <li className="py-4 text-sm text-op-muted">
                Nadie ha pagado todavía hoy.
              </li>
            )}
            {topItemsRaw.map((t, i) => (
              <li
                key={t.nameSnapshot}
                className="py-2.5 flex items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-op-muted w-4">
                    {i + 1}
                  </span>
                  <span className="text-sm">{t.nameSnapshot}</span>
                </div>
                <span className="font-mono text-sm tabular">
                  {t._sum.qty ?? 0}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-8 bg-op-surface border border-op-border rounded-2xl">
        <div className="flex items-center justify-between px-5 py-3 border-b border-op-border">
          <div className="font-display text-xl">Mesas activas</div>
          <Link href="/operator/kitchen" className="text-sm text-terracotta">
            Ir a cocina →
          </Link>
        </div>
        <ul className="divide-y divide-op-border">
          {openOrders.map((o) => {
            const itemCount = o.items.reduce((s, i) => s + i.qty, 0);
            return (
              <li
                key={o.id}
                className="flex items-center justify-between px-5 py-3"
              >
                <div className="flex items-center gap-3">
                  <div className="font-display text-lg w-16">
                    Mesa {o.table.number}
                  </div>
                  <div>
                    <div className="font-mono text-sm">{o.shortCode}</div>
                    <div className="text-xs text-op-muted">
                      {itemCount} {itemCount === 1 ? "item" : "items"} ·{" "}
                      {statusLabel(o.status)} · {ageLabel(o.createdAt)}
                    </div>
                  </div>
                </div>
                <div className="font-mono tabular text-sm">
                  {fmtCOP(o.subtotalCents)}
                </div>
              </li>
            );
          })}
          {openOrders.length === 0 && (
            <li className="px-5 py-6 text-sm text-op-muted">
              No hay mesas activas en este momento.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={
        "rounded-2xl p-4 border " +
        (accent
          ? "bg-terracotta/10 border-terracotta/30"
          : "bg-op-surface border-op-border")
      }
    >
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div
        className={
          "font-display text-3xl mt-1 tracking-[-0.015em] " +
          (accent ? "text-terracotta" : "")
        }
      >
        {value}
      </div>
    </div>
  );
}

const DAYS = ["D", "L", "M", "M", "J", "V", "S"];
function dayLabel(d: Date) {
  return DAYS[d.getDay()];
}

function statusLabel(s: string) {
  switch (s) {
    case "open":
      return "Abierto";
    case "placed":
      return "Enviado";
    case "in_kitchen":
      return "En cocina";
    case "ready":
      return "Listo";
    case "served":
      return "Servido";
    case "paying":
      return "Cobrando";
    default:
      return s;
  }
}

function ageLabel(d: Date) {
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h`;
}
