import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import {
  buildHelpSearchIndex,
  visibleHelpCategories,
} from "@/lib/help/content";
import { MESERO_HELP_BASE } from "@/lib/help/constants";
import { HelpSearch } from "@/components/help/HelpSearch";
import { HelpIcon } from "@/components/help/HelpIcon";

export const dynamic = "force-dynamic";

/**
 * Ayuda dentro de la app del mesero: sólo los artículos con audiencia
 * "mesero", con su propio buscador (índice filtrado a esos artículos).
 */
export default async function MeseroAyudaPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q } = await searchParams;
  const initialQuery = (Array.isArray(q) ? q[0] : q ?? "").slice(0, 200);
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations("help");
  const categories = visibleHelpCategories(locale, "mesero");

  return (
    <div className="mx-auto w-full max-w-md px-4 py-5">
      <h1 className="text-2xl font-semibold tracking-tight text-op-text">{t("meseroTitle")}</h1>
      <p className="mt-1 mb-5 text-sm text-op-muted">{t("meseroIntro")}</p>

      {categories.length === 0 ? (
        <p className="rounded-2xl border border-op-border bg-op-surface p-4 text-sm text-op-muted">
          {t("meseroEmpty")}
        </p>
      ) : (
        <HelpSearch
          index={buildHelpSearchIndex(locale, "mesero")}
          categories={categories.map((c) => ({ id: c.id, title: c.title, icon: c.icon }))}
          basePath={MESERO_HELP_BASE}
          initialQuery={initialQuery}
          suggestions={[]}
          showSupport={false}
        >
          <div className="mt-6 space-y-6">
            {categories.map((c) => (
              <section key={c.id} aria-labelledby={`mesero-help-${c.id}`}>
                <h2
                  id={`mesero-help-${c.id}`}
                  className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-op-muted"
                >
                  <HelpIcon name={c.icon} className="h-4 w-4" />
                  {c.title}
                </h2>
                <ul className="overflow-hidden rounded-2xl border border-op-border bg-op-surface">
                  {c.articles.map((a) => (
                    <li key={a.slug} className="border-b border-op-border last:border-b-0">
                      <Link
                        href={`${MESERO_HELP_BASE}/${c.id}/${a.slug}`}
                        className="flex items-start gap-3 px-4 py-3 active:bg-op-bg"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium text-op-text">{a.title}</span>
                          <span className="mt-0.5 block text-sm text-op-muted">{a.summary}</span>
                        </span>
                        <HelpIcon name="chevron" className="mt-1 h-4 w-4 shrink-0 text-op-muted" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </HelpSearch>
      )}
    </div>
  );
}
