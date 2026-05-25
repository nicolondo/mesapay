import Link from "next/link";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { MeserosClient } from "./MeserosClient";

export const dynamic = "force-dynamic";

export default async function MeserosSettingsPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const [tables, meseros] = await Promise.all([
    db.table.findMany({
      where: { restaurantId, number: { gte: 0 } },
      select: { number: true, label: true },
      orderBy: { number: "asc" },
    }),
    db.user.findMany({
      where: { restaurantId, role: "mesero" },
      select: {
        id: true,
        email: true,
        name: true,
        assignedTableNumbers: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        ← Configuración
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">Mesas por mesero</div>
      <p className="text-sm text-op-muted mb-6">
        Asigna a cada mesero las mesas que atiende. Solo verá en Salón,
        Cobros y Mesas las que estén marcadas. Si ninguna está marcada,
        el mesero ve todas (útil para turnos donde no hay división por
        zona).
      </p>

      {meseros.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface p-8 text-center text-sm text-op-muted">
          Todavía no tienes meseros creados. Pídele a soporte que los cree
          desde el admin con rol <em>Mesero</em>.
        </div>
      ) : tables.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface p-8 text-center text-sm text-op-muted">
          Crea primero las mesas del restaurante en{" "}
          <Link
            href="/operator/tables"
            className="text-terracotta hover:underline"
          >
            Mesas
          </Link>
          .
        </div>
      ) : (
        <MeserosClient
          tables={tables.map((t) => ({ number: t.number, label: t.label }))}
          meseros={meseros.map((m) => ({
            id: m.id,
            email: m.email,
            name: m.name,
            assignedTableNumbers: m.assignedTableNumbers,
          }))}
        />
      )}
    </div>
  );
}
