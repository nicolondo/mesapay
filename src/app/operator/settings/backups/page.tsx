import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { listBackups } from "@/lib/backups";
import { BackupsClient, type BackupDto } from "./BackupsClient";

export const dynamic = "force-dynamic";

/**
 * Configuración → Copias de seguridad: snapshot de todos los datos del
 * comercio guardado en la base, con creación manual, automática diaria y
 * restauración por fecha. Ver src/lib/backups.
 */
export default async function BackupsSettingsPage() {
  const t = await getTranslations("opBackups");
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const initial: BackupDto[] = (await listBackups(restaurantId)).map((b) => ({
    ...b,
    createdAt: b.createdAt.toISOString(),
    expiresAt: b.expiresAt.toISOString(),
  }));

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
      >
        {tSettings("backToSettings")}
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">{t("title")}</div>
      <p className="text-sm text-op-muted mb-6">{t("intro")}</p>

      <BackupsClient initial={initial} />
    </div>
  );
}
