import Link from "next/link";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { FloorPlanEditor, type EditorTable } from "./FloorPlanEditor";

export const dynamic = "force-dynamic";

export default async function SalonEditorPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tables = await db.table.findMany({
    where: { restaurantId, number: { gte: 0 } },
    orderBy: { number: "asc" },
    select: {
      id: true,
      number: true,
      label: true,
      capacity: true,
      shape: true,
      floorPlanX: true,
      floorPlanY: true,
    },
  });

  const rows: EditorTable[] = tables.map((t) => ({
    id: t.id,
    number: t.number,
    label: t.label,
    capacity: t.capacity,
    shape: t.shape,
    x: t.floorPlanX,
    y: t.floorPlanY,
  }));

  return (
    <div className="p-6 max-w-4xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="text-sm text-op-muted hover:underline"
      >
        ← Configuración
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">Mapa del salón</div>
      <p className="text-sm text-op-muted mb-6">
        Acomodá tus mesas como están en el local. El cliente verá este
        mapa al reservar y podrá elegir su mesa. Tocá una mesa, después
        tocá dónde va.
      </p>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-op-border bg-op-surface px-4 py-10 text-center text-sm text-op-muted">
          No hay mesas todavía. Creá mesas desde{" "}
          <Link href="/operator/tables" className="text-terracotta hover:underline">
            Mesas
          </Link>
          .
        </div>
      ) : (
        <FloorPlanEditor initialTables={rows} />
      )}
    </div>
  );
}
