import { getTranslations } from "next-intl/server";
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
  const t = await getTranslations("opAdminPlans");
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
        {t("platformLabel")}
      </div>
      <div className="font-display text-3xl tracking-[-0.015em] mb-1">
        {t("title")}
      </div>
      <p className="text-sm text-op-muted mb-6">
        {t("intro")}
      </p>

      <PlansClient
        initialPlans={plans}
        countByTier={countByTier}
      />
    </div>
  );
}
