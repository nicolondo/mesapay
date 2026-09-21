import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { reportGate } from "./_components/gate";

export const dynamic = "force-dynamic";

/**
 * Hub «Todos los reportes» (portado de zenith `/reportes`): tarjetas por
 * categoría con nombre, destino y una línea de detalle. Los reportes que
 * todavía viven como pestañas de /operator/contabilidad (estados,
 * impuestos, exógena) enlazan allí: `ContabilidadClient` no lee la
 * pestaña de la URL, así que no hay `?tab=` que respetar.
 */
export default async function ReportesHubPage() {
  const t = await getTranslations("opReportes");
  const tSettings = await getTranslations("opSettings");
  const tCartera = await getTranslations("opCartera");
  const gate = await reportGate();
  if (!gate) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const categories: {
    key: string;
    label: string;
    items: { href: string; name: string; detail: string }[];
  }[] = [
    {
      key: "contables",
      label: t("catContables"),
      items: [
        { href: "/operator/reportes/libro-diario", name: t("rDiario"), detail: t("rDiarioDesc") },
        { href: "/operator/reportes/libro-mayor", name: t("rMayor"), detail: t("rMayorDesc") },
        { href: "/operator/reportes/balance-prueba", name: t("rBalance"), detail: t("rBalanceDesc") },
        {
          href: "/operator/contabilidad/comprobantes",
          name: t("rComprobantes"),
          detail: t("rComprobantesDesc"),
        },
      ],
    },
    {
      key: "financieros",
      label: t("catFinancieros"),
      items: [
        { href: "/operator/contabilidad", name: t("rEsf"), detail: t("rEsfDesc") },
        { href: "/operator/contabilidad", name: t("rEr"), detail: t("rErDesc") },
      ],
    },
    {
      key: "tributarios",
      label: t("catTributarios"),
      items: [
        { href: "/operator/contabilidad", name: t("rImpuestos"), detail: t("rImpuestosDesc") },
        { href: "/operator/contabilidad", name: t("rExogena"), detail: t("rExogenaDesc") },
      ],
    },
    {
      key: "comerciales",
      label: tCartera("hubCategory"),
      items: [
        { href: "/operator/reportes/cartera", name: tCartera("hubName"), detail: tCartera("hubDesc") },
      ],
    },
  ];

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">{t("hubTitle")}</div>
      <p className="text-sm text-op-muted mb-6">{t("hubIntro")}</p>

      <div className="space-y-8">
        {categories.map((cat) => (
          <section key={cat.key}>
            <h2 className="text-[11px] uppercase tracking-wider text-op-muted mb-3">{cat.label}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {cat.items.map((item) => (
                <Link
                  key={item.href + item.name}
                  href={item.href}
                  className="group rounded-2xl border border-op-border bg-op-surface p-4 transition-colors hover:border-op-accent"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="font-medium">{item.name}</div>
                    <span
                      aria-hidden
                      className="text-op-muted transition-transform group-hover:translate-x-0.5"
                    >
                      →
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-op-muted">{item.detail}</p>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
