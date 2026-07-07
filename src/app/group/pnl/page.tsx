import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getActiveGroupShellContext } from "@/lib/activeRestaurant";
import { GroupPnlClient } from "./GroupPnlClient";

export const dynamic = "force-dynamic";

/**
 * P&L consolidado del grupo (ERP B2 · D4): suma las sedes con el módulo
 * `accounting` activo; las apagadas se listan sin números. Auth: el
 * layout /group ya gatea group_admin — acá solo re-chequeamos el
 * contexto (patrón razones-sociales). Los datos viven en
 * GET /api/group/pnl; el client hace fetch por mes con caché.
 */
export default async function GroupPnlPage() {
  const t = await getTranslations("opGroup");
  const ctx = await getActiveGroupShellContext();
  if (!ctx) redirect("/group");

  return (
    <div className="flex-1 p-4 md:p-6 max-w-4xl mx-auto w-full">
      <Link
        href="/group"
        className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
      >
        {t("gpBackToGroup")}
      </Link>
      <div className="font-display text-3xl tracking-[-0.015em] mt-2 mb-1">
        {t("gpTitle")}
      </div>
      <p className="text-sm text-op-muted mb-5">{t("gpIntro")}</p>
      <GroupPnlClient />
    </div>
  );
}
