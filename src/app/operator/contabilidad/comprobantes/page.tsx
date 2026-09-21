import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ComprobantesClient } from "./ComprobantesClient";
import { loadComprobantesContext } from "./gate";
import { firstOfMonth, LIST_PATH, todayYmd } from "./shared";

export const dynamic = "force-dynamic";

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Libro de comprobantes (port de zenith /contabilidad/comprobantes): todos
 * los asientos del comercio — los que genera el motor y los manuales — con
 * número consecutivo, fecha, tercero, origen y total. Los filtros viven en
 * la URL (form GET) y se aplican server-side sobre TODO el libro; la lista
 * pagina por cursor. Rango por defecto: primer día del mes → hoy.
 */
export default async function ComprobantesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; desde?: string; hasta?: string }>;
}) {
  const t = await getTranslations("opComprobantes");
  const tSettings = await getTranslations("opSettings");
  const ctx = await loadComprobantesContext();
  if (ctx === "no_restaurant") {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }
  const sp = await searchParams;
  const today = todayYmd();
  const desde = YMD.test(sp.desde ?? "") ? sp.desde! : firstOfMonth(today);
  const hasta = YMD.test(sp.hasta ?? "") ? sp.hasta! : today;
  const q = (sp.q ?? "").trim().slice(0, 80);
  const exportHref = `/api/operator/accounting/entries/export?desde=${desde}&hasta=${hasta}`;

  return (
    <div className="p-6 max-w-5xl mx-auto w-full">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-1">
        <div className="min-w-0">
          <div className="font-display text-3xl">{t("title")}</div>
          <Link
            href="/operator/contabilidad"
            className="text-xs text-op-muted hover:text-op-accent hover:underline"
          >
            {t("backToAccounting")}
          </Link>
        </div>
        <div className="flex gap-2 shrink-0">
          <a href={exportHref} className="mp-btn mp-btn--ghost px-4">
            {t("exportCsv")}
          </a>
          <Link href={`${LIST_PATH}/nuevo`} className="mp-btn mp-btn--primary px-4">
            {t("newEntry")}
          </Link>
        </div>
      </div>
      <p className="text-sm text-op-muted mb-6">{t("intro")}</p>

      {/* key: al cambiar los filtros el cliente se remonta y arranca limpio. */}
      <ComprobantesClient
        key={`${q}|${desde}|${hasta}`}
        currency={ctx.currency}
        q={q}
        desde={desde}
        hasta={hasta}
      />
    </div>
  );
}
