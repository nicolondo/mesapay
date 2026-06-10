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

  const comerciales = await db.user.findMany({
    where: { role: "comercial" },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });

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
