import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { loadComprobantesContext } from "../comprobantes/gate";
import { DiferidosClient } from "./DiferidosClient";

export const dynamic = "force-dynamic";

/**
 * Diferidos (port de zenith /contabilidad/diferidos): gastos pagados por
 * anticipado e ingresos recibidos por anticipado con amortización mensual
 * automática. Mismo gate que comprobantes: módulo `accounting` activo.
 */
export default async function DiferidosPage() {
  const t = await getTranslations("opDiferidos");
  const tSettings = await getTranslations("opSettings");
  const ctx = await loadComprobantesContext();
  if (ctx === "no_restaurant") {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }
  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="mb-1">
        <div className="font-display text-3xl">{t("title")}</div>
        <Link
          href="/operator/contabilidad"
          className="text-xs text-op-muted hover:text-op-accent hover:underline"
        >
          {t("backToAccounting")}
        </Link>
      </div>
      <p className="text-sm text-op-muted mb-6">{t("intro")}</p>
      <DiferidosClient currency={ctx.currency} />
    </div>
  );
}
