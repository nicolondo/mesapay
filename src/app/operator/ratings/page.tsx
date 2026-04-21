import { db } from "@/lib/db";
import { fmtBogotaDateTime } from "@/lib/bogota";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { Stars } from "@/app/t/[slug]/order/[orderId]/RatingInline";

export const dynamic = "force-dynamic";

export default async function OperatorRatingsPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const [ratings, items] = await Promise.all([
    db.dishRating.findMany({
      where: { restaurantId },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        menuItem: { select: { name: true } },
        order: { select: { shortCode: true } },
      },
    }),
    db.menuItem.findMany({
      where: { restaurantId },
      select: { id: true, name: true },
    }),
  ]);

  const agg = new Map<string, { total: number; count: number }>();
  for (const r of ratings) {
    const e = agg.get(r.menuItemId) ?? { total: 0, count: 0 };
    e.total += r.stars;
    e.count += 1;
    agg.set(r.menuItemId, e);
  }
  const itemsWithAvg = items
    .map((i) => {
      const e = agg.get(i.id);
      return {
        id: i.id,
        name: i.name,
        avg: e ? e.total / e.count : 0,
        count: e ? e.count : 0,
      };
    })
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count || b.avg - a.avg);

  const totalRatings = ratings.length;
  const globalAvg =
    totalRatings > 0
      ? ratings.reduce((s, r) => s + r.stars, 0) / totalRatings
      : 0;

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="font-display text-3xl mb-5">Reseñas</div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-8">
        <Stat
          label="Total de reseñas"
          value={totalRatings.toString()}
        />
        <Stat
          label="Promedio global"
          value={totalRatings > 0 ? globalAvg.toFixed(2) : "—"}
          right={<Stars stars={Math.round(globalAvg)} size={18} />}
        />
        <Stat
          label="Platos con reseña"
          value={itemsWithAvg.length.toString()}
        />
      </div>

      {itemsWithAvg.length > 0 && (
        <section className="mb-10">
          <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
            Por plato
          </div>
          <ul className="divide-y divide-op-border border border-op-border rounded-xl bg-op-surface overflow-hidden">
            {itemsWithAvg.map((i) => (
              <li key={i.id} className="p-4 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{i.name}</div>
                  <div className="text-xs text-op-muted mt-0.5">
                    {i.count} {i.count === 1 ? "reseña" : "reseñas"}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Stars stars={Math.round(i.avg)} size={18} />
                  <span className="font-mono text-sm tabular w-10 text-right">
                    {i.avg.toFixed(1)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
          Comentarios recientes
        </div>
        {ratings.length === 0 ? (
          <div className="text-sm text-op-muted border border-dashed border-op-border rounded-xl p-8 text-center">
            Aún no tienes reseñas.
          </div>
        ) : (
          <ul className="space-y-3">
            {ratings.map((r) => {
              const { date, time } = fmtBogotaDateTime(r.createdAt);
              return (
                <li
                  key={r.id}
                  className="border border-op-border bg-op-surface rounded-xl p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">
                        {r.menuItem.name}
                      </div>
                      <div className="text-xs text-op-muted mt-0.5">
                        {r.order.shortCode} ·{" "}
                        {r.guestName ? r.guestName : "Anónimo"} · {date} {time}
                      </div>
                    </div>
                    <Stars stars={r.stars} size={16} />
                  </div>
                  {r.comment && (
                    <div className="mt-2 text-sm text-op-text">
                      “{r.comment}”
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  right,
}: {
  label: string;
  value: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="border border-op-border rounded-xl bg-op-surface p-4">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">
        {label}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <div className="font-display text-2xl tabular">{value}</div>
        {right}
      </div>
    </div>
  );
}
