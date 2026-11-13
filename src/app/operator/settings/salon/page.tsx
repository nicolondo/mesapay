import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { resolveFloor } from "@/lib/floorPlan";
import { FloorPlanEditor, type EditorTable } from "./FloorPlanEditor";

export const dynamic = "force-dynamic";

export default async function SalonEditorPage() {
  const t = await getTranslations("opSalon");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const [tables, restaurant] = await Promise.all([
    db.table.findMany({
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
        floorX: true,
        floorY: true,
        floorW: true,
        floorH: true,
        floorRotation: true,
      },
    }),
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { floorPlan: true },
    }),
  ]);

  // Plano libre, o el de celdas convertido al vuelo (no se escribe nada
  // hasta que el dueño toque «Guardar mapa»).
  const { scene, placements } = resolveFloor(restaurant?.floorPlan, tables);

  const rows: EditorTable[] = tables.map((tb) => ({
    id: tb.id,
    number: tb.number,
    label: tb.label,
    capacity: tb.capacity,
    shape: tb.shape,
    placement: placements[tb.id] ?? null,
  }));

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto w-full">
      <Link href="/operator/settings" className="text-sm text-op-muted hover:underline">
        {t("backToSettings")}
      </Link>
      <h1 className="font-display text-3xl mt-2 mb-1">{t("title")}</h1>
      <p className="text-sm text-op-muted mb-5 max-w-[72ch]">{t("intro")}</p>

      {/* Sin mesas también se abre: se puede dibujar el salón y crear las
          mesas desde la bandeja («Nueva mesa»). */}
      <FloorPlanEditor restaurantId={restaurantId} initialTables={rows} initialScene={scene} />
    </div>
  );
}
