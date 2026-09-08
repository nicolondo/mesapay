import Link from "next/link";
import { getTranslations } from "next-intl/server";

/**
 * Pantalla que ve el mesero si llega a /mesero/cobrar/[orderId] con el
 * control de caja activo ("solo el administrador inicia el cobro").
 *
 * No debería llegar acá — el botón de cobrar ya no se le muestra en
 * Mesas ni en Salón —, pero la URL es adivinable y puede quedar en el
 * historial de la PWA. En vez de dejarlo chocar contra un 403 de la API,
 * le explicamos el porqué y le ofrecemos la acción que SÍ puede hacer:
 * avisarle a caja desde la mesa.
 */
export async function ChargeLockedByAdmin() {
  const t = await getTranslations("chargeLock");
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-hairline bg-paper p-6 text-center space-y-4">
        <div className="text-3xl" aria-hidden>
          {"🔒"}
        </div>
        <div>
          <h1 className="font-display text-2xl">{t("title")}</h1>
          <p className="text-sm text-muted mt-2">{t("body")}</p>
        </div>
        <Link
          href="/mesero/mesas"
          className="w-full h-12 rounded-2xl bg-ink text-bone text-base font-medium inline-flex items-center justify-center"
        >
          {t("backToTables")}
        </Link>
      </div>
    </div>
  );
}
