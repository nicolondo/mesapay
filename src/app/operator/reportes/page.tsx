import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { REPORT_CATALOG, type ReportNs } from "@/lib/erp/reports/catalog";
import { reportGate } from "./_components/gate";

export const dynamic = "force-dynamic";

/**
 * Hub «Todos los reportes» (portado de zenith `/reportes`): tarjetas por
 * categoría con nombre, destino y una línea de detalle. El catálogo es dato
 * puro en `@/lib/erp/reports/catalog` (con test de que cada ruta exista);
 * acá sólo se traduce y se pinta. Los reportes operativos que siguen siendo
 * pestañas de /operator/contabilidad enlazan con `?tab=`, que la página ya
 * respeta.
 */
export default async function ReportesHubPage() {
  const t = await getTranslations("opReportes");
  const tSettings = await getTranslations("opSettings");
  const gate = await reportGate();
  if (!gate) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const dict: Record<ReportNs, Awaited<ReturnType<typeof getTranslations>>> = {
    opReportes: t,
    opCartera: await getTranslations("opCartera"),
    opComisiones: await getTranslations("opComisiones"),
  };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">{t("hubTitle")}</div>
      <p className="text-sm text-op-muted mb-6">{t("hubIntro")}</p>

      <div className="space-y-8">
        {REPORT_CATALOG.map((cat) => (
          <section key={cat.key}>
            <h2 className="text-[11px] uppercase tracking-wider text-op-muted mb-3">
              {dict[cat.ns](cat.labelKey)}
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {cat.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group rounded-2xl border border-op-border bg-op-surface p-4 transition-colors hover:border-op-accent"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="font-medium">{dict[item.ns](item.nameKey)}</div>
                    <span
                      aria-hidden
                      className="text-op-muted transition-transform group-hover:translate-x-0.5"
                    >
                      →
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-op-muted">{dict[item.ns](item.descKey)}</p>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
