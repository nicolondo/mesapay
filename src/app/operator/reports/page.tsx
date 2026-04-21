import Link from "next/link";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { addDaysIso, bogotaDayRange, bogotaTodayIso, fmtBogotaDateTime } from "@/lib/bogota";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

export const dynamic = "force-dynamic";

const METHOD_LABEL: Record<string, string> = {
  demo_card: "Tarjeta (demo)",
  demo_cash: "Efectivo",
  wompi_card: "Tarjeta",
  wompi_pse: "PSE",
  wompi_nequi: "Nequi",
};

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const sp = await searchParams;
  const dateIso = validIso(sp.date) ?? bogotaTodayIso();
  const { start, end } = bogotaDayRange(dateIso);
  const todayIso = bogotaTodayIso();
  const prevDay = addDaysIso(dateIso, -1);
  const nextDay = addDaysIso(dateIso, 1);
  const isToday = dateIso === todayIso;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { serviceMode: true },
  });
  const counterMode = tenant?.serviceMode === "counter";

  const payments = await db.payment.findMany({
    where: {
      status: "approved",
      createdAt: { gte: start, lt: end },
      order: { restaurantId },
    },
    include: {
      order: {
        select: {
          shortCode: true,
          tipCents: true,
          subtotalCents: true,
          totalCents: true,
          paidAt: true,
          table: { select: { number: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const paidOrders = await db.order.findMany({
    where: {
      restaurantId,
      status: "paid",
      paidAt: { gte: start, lt: end },
    },
    select: { id: true, subtotalCents: true, tipCents: true, totalCents: true },
  });

  const byMethod = new Map<string, { count: number; sum: number }>();
  for (const p of payments) {
    const m = byMethod.get(p.method) ?? { count: 0, sum: 0 };
    m.count += 1;
    m.sum += p.amountCents;
    byMethod.set(p.method, m);
  }
  const paymentsTotal = payments.reduce((s, p) => s + p.amountCents, 0);
  const tipsTotal = paidOrders.reduce((s, o) => s + o.tipCents, 0);
  const subtotalTotal = paidOrders.reduce((s, o) => s + o.subtotalCents, 0);

  // Top-selling dishes from today's paid orders (qty + revenue).
  const paidItems = await db.orderItem.findMany({
    where: {
      order: {
        restaurantId,
        status: "paid",
        paidAt: { gte: start, lt: end },
      },
    },
    select: {
      menuItemId: true,
      nameSnapshot: true,
      qty: true,
      priceCentsSnapshot: true,
    },
  });
  const dishAgg = new Map<
    string,
    { name: string; qty: number; revenue: number }
  >();
  for (const i of paidItems) {
    const e = dishAgg.get(i.menuItemId) ?? {
      name: i.nameSnapshot,
      qty: 0,
      revenue: 0,
    };
    e.qty += i.qty;
    e.revenue += i.qty * i.priceCentsSnapshot;
    dishAgg.set(i.menuItemId, e);
  }
  const topDishes = Array.from(dishAgg.values())
    .sort((a, b) => b.qty - a.qty || b.revenue - a.revenue)
    .slice(0, 10);
  const dishesTotalQty = paidItems.reduce((s, i) => s + i.qty, 0);

  // Orders cancelled today (opened today and ended up cancelled).
  const cancelledCount = await db.order.count({
    where: {
      restaurantId,
      status: "cancelled",
      createdAt: { gte: start, lt: end },
    },
  });

  // Ratings posted during this day.
  const ratings = await db.dishRating.findMany({
    where: {
      restaurantId,
      createdAt: { gte: start, lt: end },
    },
    select: { stars: true },
  });
  const ratingsCount = ratings.length;
  const ratingsAvg =
    ratingsCount > 0
      ? ratings.reduce((s, r) => s + r.stars, 0) / ratingsCount
      : 0;

  const downloadHref = `/api/operator/reports/close-of-day?date=${dateIso}`;

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-end justify-between flex-wrap gap-4 mb-6">
        <div>
          <div className="font-display text-3xl">Cierre de día</div>
          <p className="text-sm text-op-muted mt-1">
            Cobros y pedidos del día en hora Colombia.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <form action="/operator/reports" className="flex items-end gap-2">
            <label className="flex flex-col">
              <span className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1">
                Fecha
              </span>
              <input
                type="date"
                name="date"
                defaultValue={dateIso}
                max={todayIso}
                className="h-9 px-3 rounded-lg border border-op-border bg-op-surface text-sm"
              />
            </label>
            <button
              type="submit"
              className="h-9 px-4 rounded-full bg-ink text-bone text-sm"
            >
              Ver
            </button>
          </form>
          <div className="inline-flex border border-op-border rounded-full bg-op-surface">
            <Link
              href={`/operator/reports?date=${prevDay}`}
              className="px-3 h-9 inline-flex items-center text-sm text-op-text/80"
              aria-label="Día anterior"
            >
              ←
            </Link>
            <Link
              href={`/operator/reports?date=${todayIso}`}
              className={
                "px-3 h-9 inline-flex items-center text-xs " +
                (isToday ? "text-op-muted" : "text-op-text/80")
              }
            >
              Hoy
            </Link>
            <Link
              href={`/operator/reports?date=${nextDay}`}
              aria-disabled={isToday}
              className={
                "px-3 h-9 inline-flex items-center text-sm " +
                (isToday ? "text-op-muted pointer-events-none opacity-40" : "text-op-text/80")
              }
            >
              →
            </Link>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <Stat label="Cobrado" value={fmtCOP(paymentsTotal)} hint={`${payments.length} cobro${payments.length === 1 ? "" : "s"}`} />
        <Stat label="Órdenes pagadas" value={String(paidOrders.length)} hint={fmtCOP(subtotalTotal)} />
        <Stat label="Propinas" value={fmtCOP(tipsTotal)} hint={paidOrders.length ? `Prom. ${fmtCOP(Math.round(tipsTotal / paidOrders.length))}` : "—"} />
        <Stat label="Ticket promedio" value={paidOrders.length ? fmtCOP(Math.round(subtotalTotal / paidOrders.length)) : "—"} hint="Subtotal / orden" />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Stat
          label="Platos vendidos"
          value={String(dishesTotalQty)}
          hint={`${dishAgg.size} ${dishAgg.size === 1 ? "plato distinto" : "platos distintos"}`}
        />
        <Stat
          label="Canceladas"
          value={String(cancelledCount)}
          hint={cancelledCount === 0 ? "Ninguna" : "Órdenes del día"}
        />
        <Stat
          label="Reseñas"
          value={String(ratingsCount)}
          hint={ratingsCount > 0 ? `${ratingsAvg.toFixed(1)} ★ prom.` : "—"}
        />
        <Stat
          label="Fecha"
          value={dateIso}
          hint={isToday ? "Hoy" : "Histórico"}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div className="bg-op-surface border border-op-border rounded-2xl p-5">
          <div className="flex items-baseline justify-between mb-3">
            <div className="font-display text-xl">Por método</div>
            <a
              href={downloadHref}
              className="text-sm text-terracotta hover:underline"
            >
              Descargar CSV
            </a>
          </div>
          {byMethod.size === 0 && (
            <div className="text-sm text-op-muted py-6 text-center">
              Aún no hay cobros en este día.
            </div>
          )}
          {byMethod.size > 0 && (
            <ul className="divide-y divide-op-border">
              {Array.from(byMethod.entries()).map(([method, m]) => (
                <li key={method} className="py-2.5 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">
                      {METHOD_LABEL[method] ?? method}
                    </div>
                    <div className="text-[11px] text-op-muted">
                      {m.count} cobro{m.count === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="font-mono tabular">{fmtCOP(m.sum)}</div>
                </li>
              ))}
              <li className="py-2.5 flex items-center justify-between border-t border-op-border mt-2">
                <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
                  Total cobrado
                </div>
                <div className="font-display text-xl">{fmtCOP(paymentsTotal)}</div>
              </li>
            </ul>
          )}
        </div>

        <div className="bg-op-surface border border-op-border rounded-2xl p-5">
          <div className="font-display text-xl mb-3">Top platos</div>
          {topDishes.length === 0 && (
            <div className="text-sm text-op-muted py-6 text-center">
              Sin platos vendidos en este día.
            </div>
          )}
          {topDishes.length > 0 && (
            <ul className="divide-y divide-op-border">
              {topDishes.map((d, idx) => (
                <li
                  key={d.name + idx}
                  className="py-2.5 flex items-center gap-3"
                >
                  <span className="font-mono text-[10px] tabular w-5 text-op-muted text-right">
                    {(idx + 1).toString().padStart(2, "0")}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{d.name}</div>
                    <div className="text-[11px] text-op-muted">
                      {d.qty} {d.qty === 1 ? "unidad" : "unidades"}
                    </div>
                  </div>
                  <div className="font-mono tabular text-sm shrink-0">
                    {fmtCOP(d.revenue)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4">
        <div className="bg-op-surface border border-op-border rounded-2xl p-5">
          <div className="font-display text-xl mb-3">Cobros</div>
          <div className="overflow-auto max-h-[420px]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-op-surface">
                <tr className="text-left">
                  <Th>Hora</Th>
                  <Th>Pedido</Th>
                  <Th>{counterMode ? "Canal" : "Mesa"}</Th>
                  <Th>Método</Th>
                  <Th align="right">Monto</Th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => {
                  const bt = fmtBogotaDateTime(p.createdAt);
                  return (
                    <tr key={p.id} className="border-t border-op-border">
                      <Td className="font-mono tabular">{bt.time}</Td>
                      <Td className="font-mono">{p.order.shortCode}</Td>
                      <Td>{counterMode ? "Mostrador" : p.order.table.number}</Td>
                      <Td>{METHOD_LABEL[p.method] ?? p.method}</Td>
                      <Td align="right" className="font-mono tabular">
                        {fmtCOP(p.amountCents)}
                      </Td>
                    </tr>
                  );
                })}
                {payments.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-op-muted">
                      Sin cobros en esta fecha.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function validIso(s?: string) {
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-op-surface border border-op-border rounded-2xl p-4">
      <div className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div className="font-display text-2xl mt-1 tabular">{value}</div>
      {hint && <div className="text-[11px] text-op-muted mt-0.5">{hint}</div>}
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <th
      className={
        "px-3 py-2 font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted " +
        (align === "right" ? "text-right" : "text-left")
      }
    >
      {children}
    </th>
  );
}
function Td({
  children,
  align,
  className,
}: {
  children?: React.ReactNode;
  align?: "left" | "right";
  className?: string;
}) {
  return (
    <td
      className={
        "px-3 py-2 " + (align === "right" ? "text-right " : "") + (className ?? "")
      }
    >
      {children}
    </td>
  );
}
