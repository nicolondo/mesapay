import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { ReservasBoard, type ReservationRow } from "./ReservasBoard";

export const dynamic = "force-dynamic";

const SOURCE_LABEL: Record<string, string> = {
  direct: "Link directo",
  google_maps: "Google Maps",
  whatsapp: "WhatsApp",
  phone: "Teléfono",
};

export default async function OperatorReservasPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { reservationsEnabled: true, slug: true },
  });
  if (!tenant) return <div className="p-6">Restaurante no encontrado.</div>;

  if (!tenant.reservationsEnabled) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="font-display text-3xl mb-2">Reservas</div>
        <p className="text-sm text-op-muted">
          El módulo de reservas está desactivado. Actívalo en{" "}
          <a
            href="/operator/settings/reservas"
            className="text-terracotta hover:underline"
          >
            Configuración → Reservas
          </a>
          .
        </p>
      </div>
    );
  }

  // Próximas + las del día actual (desde el inicio del día UTC-5 ~
  // tomamos las últimas 6h para mostrar las que recién pasaron / están
  // en curso). Cerradas (completed/cancelled/no_show) viejas no se
  // listan para no saturar.
  const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const reservations = await db.reservation.findMany({
    where: {
      restaurantId,
      startsAt: { gte: since },
    },
    include: {
      table: { select: { number: true, label: true } },
    },
    orderBy: { startsAt: "asc" },
    take: 200,
  });

  const rows: ReservationRow[] = reservations.map((r) => ({
    id: r.id,
    customerName: r.customerName,
    customerEmail: r.customerEmail,
    customerPhone: r.customerPhone,
    partySize: r.partySize,
    startsAtISO: r.startsAt.toISOString(),
    status: r.status,
    source: r.source,
    notes: r.notes,
    tableLabel: r.table.label ?? `Mesa ${r.table.number}`,
    confirmationCode: r.confirmationCode,
  }));

  // Reservas por fuente en los últimos 30 días — métrica para medir
  // de dónde vienen (especialmente cuánto trae Google Maps). Solo
  // cuenta las que no se cancelaron.
  const thirtyAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const bySource = await db.reservation.groupBy({
    by: ["source"],
    where: {
      restaurantId,
      createdAt: { gte: thirtyAgo },
      status: { not: "cancelled" },
    },
    _count: { _all: true },
  });
  const sourceStats = bySource.map((s) => ({
    source: s.source,
    count: s._count._all,
  }));

  return (
    <div className="p-6 max-w-4xl mx-auto w-full">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-1">
        <div className="font-display text-3xl">Reservas</div>
        <a
          href="/operator/settings/reservas"
          className="text-sm text-op-muted hover:text-op-text"
        >
          Configurar →
        </a>
      </div>
      <p className="text-sm text-op-muted mb-4">
        Próximas reservas y las de hoy. Confirmá, marcá llegada o no-show.
      </p>

      {sourceStats.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          <span className="text-[11px] text-op-muted self-center">
            Últimos 30 días:
          </span>
          {sourceStats.map((s) => (
            <span
              key={s.source}
              className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-op-surface border border-op-border text-xs"
            >
              {SOURCE_LABEL[s.source] ?? s.source}
              <strong className="font-mono">{s.count}</strong>
            </span>
          ))}
        </div>
      )}

      <ReservasBoard initialRows={rows} />
    </div>
  );
}
