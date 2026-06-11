import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { CommissionsClient } from "./CommissionsClient";

export const dynamic = "force-dynamic";

/**
 * /admin/comisiones — libro global de comisiones (platform_admin only).
 * La página server-side sólo carga la lista de comerciales para el
 * filtro; el cliente hace el fetch real de entradas desde
 * GET /api/admin/commissions con sus filtros.
 */
export default async function AdminComisionesPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/admin/comisiones");
  if (session.user.role !== "platform_admin") redirect("/admin");

  const t = await getTranslations("opAdminCommissions");

  // Fetch comerciales with aggregates for the management table.
  const [comercialesRaw, pendingTotals] = await Promise.all([
    db.user.findMany({
      where: { role: "comercial" },
      select: {
        id: true,
        name: true,
        email: true,
        commissionBps: true,
        disabledAt: true,
        _count: { select: { referredRestaurants: true } },
      },
      orderBy: { name: "asc" },
    }),
    db.commissionEntry.groupBy({
      by: ["salesRepUserId"],
      where: { status: "pending" },
      _sum: { amountCents: true },
    }),
  ]);

  // Map pendingTotals by userId for O(1) lookup.
  const pendingByRep: Record<string, number> = {};
  for (const row of pendingTotals) {
    pendingByRep[row.salesRepUserId] = row._sum.amountCents ?? 0;
  }

  const comerciales = comercialesRaw.map((rep) => ({
    id: rep.id,
    name: rep.name,
    email: rep.email,
    commissionBps: rep.commissionBps,
    disabledAt: rep.disabledAt?.toISOString() ?? null,
    restaurantCount: rep._count.referredRestaurants,
    pendingCents: pendingByRep[rep.id] ?? 0,
  }));

  return (
    <div className="flex-1 p-4 md:p-6 max-w-6xl mx-auto w-full">
      <div className="font-mono text-[10px] tracking-wider uppercase text-op-muted mb-1">
        {"MESAPAY"}
      </div>
      <div className="font-display text-3xl tracking-[-0.015em] mb-1">
        {t("pageTitle")}
      </div>
      <p className="text-sm text-op-muted mb-6">{t("pageSubtitle")}</p>

      <CommissionsClient comerciales={comerciales} />
    </div>
  );
}
