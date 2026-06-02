import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { NewRestaurantClient } from "./NewRestaurantClient";

export const dynamic = "force-dynamic";

/**
 * Wizard para crear un restaurante nuevo dentro del grupo. Auth
 * la gestiona el layout (/group/layout.tsx). Form chico — sólo
 * nombre + slug + modo de servicio. Todo lo demás (identidad,
 * pagos, menú) se configura después desde el operator del nuevo
 * local.
 */
export default async function NewRestaurantPage() {
  const t = await getTranslations("opGroup");
  return (
    <div className="flex-1 p-4 md:p-6 max-w-2xl mx-auto w-full">
      <Link
        href="/group"
        className="font-mono text-[10px] tracking-wider uppercase text-op-muted hover:text-op-text"
      >
        {t("newRestaurantBackToGroup")}
      </Link>
      <div className="font-display text-3xl tracking-[-0.015em] mt-2 mb-1">
        {t("newRestaurantTitle")}
      </div>
      <p className="text-sm text-op-muted mb-6">{t("newRestaurantIntro")}</p>
      <NewRestaurantClient />
    </div>
  );
}
