import { db } from "@/lib/db";
import { getPlanCatalog } from "@/lib/planCatalog";
import { PlansClient } from "./PlansClient";

export const dynamic = "force-dynamic";

/**
 * /admin/plans — catálogo de planes editable.
 *
 * Carga el catálogo (con self-seed la primera vez) + conteo de
 * restaurantes en cada tier para que el admin vea cuántos clientes
 * tiene en cada plan antes de cambiar precios.
 */
export default async function AdminPlansPage() {
  const [plans, counts] = await Promise.all([
    getPlanCatalog(),
    db.restaurant.groupBy({
      by: ["plan"],
      _count: { _all: true },
    }),
  ]);

  const countByTier: Record<string, number> = {};
  for (const c of counts) {
    countByTier[c.plan] = c._count._all;
  }

  return (
    <div className="flex-1 p-4 md:p-6 max-w-3xl mx-auto w-full">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
        Plataforma
      </div>
      <div className="font-display text-3xl tracking-[-0.015em] mb-1">
        Planes
      </div>
      <p className="text-sm text-op-muted mb-6">
        Edita los nombres, precios sugeridos, descripción y features
        de cada plan. Estos valores aparecen en el detalle de cada
        restaurante al asignar plan, y como precio sugerido por
        defecto.
      </p>

      <PlansClient
        initialPlans={plans}
        countByTier={countByTier}
      />
    </div>
  );
}
