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
    <div className="mp-page mp-page--narrow">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
        {t("platformLabel")}
      </div>
      <h1 className="mp-page-title mb-2">
        {t("title")}
      </h1>
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
