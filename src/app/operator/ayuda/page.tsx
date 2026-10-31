import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import {
  buildHelpSearchIndex,
  visibleHelpCategories,
} from "@/lib/help/content";
import {
  OPERATOR_HELP_BASE,
  PRINT_AGENT_ARTICLE,
  SUPPORT_EMAIL,
  supportMailto,
} from "@/lib/help/constants";
import { HelpSearch } from "@/components/help/HelpSearch";
import { HelpIcon } from "@/components/help/HelpIcon";
import { PrintAgentDownload } from "@/components/help/PrintAgentDownload";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("help");
  return { title: t("metaTitle") };
}

/**
 * Centro de ayuda del operador: buscador arriba (con foco automático y atajo
 * "/"), las categorías con contenido como tarjetas, y los accesos directos a
 * soporte y a la instalación del agente de impresión.
 *
 * El índice del buscador se arma acá, en el servidor, sólo para el idioma
 * activo, y es lo único del contenido que viaja al navegador.
 */
export default async function AyudaPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q } = await searchParams;
  const initialQuery = (Array.isArray(q) ? q[0] : q ?? "").slice(0, 200);
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations("help");

  const categories = visibleHelpCategories(locale);
  const index = buildHelpSearchIndex(locale);
  const suggestions = categories
    .slice(0, 6)
    .map((c) => ({ c: c.id, s: c.articles[0].slug, t: c.articles[0].title }));
  const agentArticleVisible = categories.some(
    (c) =>
      c.id === PRINT_AGENT_ARTICLE.category &&
      c.articles.some((a) => a.slug === PRINT_AGENT_ARTICLE.slug),
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6">
        <p className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-op-muted">
          {t("eyebrow")}
        </p>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-op-text sm:text-4xl">
          {t("title")}
        </h1>
        <p className="mt-3 max-w-2xl text-base leading-relaxed text-op-muted">{t("intro")}</p>
      </header>

      <HelpSearch
        index={index}
        categories={categories.map((c) => ({ id: c.id, title: c.title, icon: c.icon }))}
        basePath={OPERATOR_HELP_BASE}
        initialQuery={initialQuery}
        suggestions={suggestions}
        autoFocus
      >
        <section aria-labelledby="help-topics" className="mt-10">
          <h2
            id="help-topics"
            className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-op-muted"
          >
            {t("categoriesTitle")}
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {categories.map((c) => (
              <li key={c.id}>
                <Link
                  href={`${OPERATOR_HELP_BASE}/${c.id}`}
                  className="flex h-full flex-col rounded-2xl border border-op-border bg-op-surface p-4 transition-colors hover:border-op-text"
                >
                  <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-op-bg text-op-text">
                    <HelpIcon name={c.icon} />
                  </span>
                  <span className="font-semibold text-op-text">{c.title}</span>
                  <span className="mt-1 flex-1 text-sm leading-relaxed text-op-muted">
                    {c.description}
                  </span>
                  <span className="mt-3 text-xs font-medium text-op-muted">
                    {t("categoryArticleCount", { count: c.articles.length })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </HelpSearch>

      <section aria-labelledby="help-shortcuts" className="mt-10">
        <h2
          id="help-shortcuts"
          className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-op-muted"
        >
          {t("shortcutsTitle")}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col rounded-2xl border border-op-border bg-op-surface p-5">
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-op-bg text-op-text">
              <HelpIcon name="mail" />
            </span>
            <h3 className="font-semibold text-op-text">{t("supportTitle")}</h3>
            <p className="mt-1 flex-1 text-sm text-op-muted">{t("supportBody")}</p>
            <div className="mt-4">
              <a
                href={supportMailto()}
                className="inline-flex min-h-[44px] items-center justify-center rounded-full bg-ink px-5 text-sm font-medium text-bone hover:bg-ink/90"
              >
                {t("supportCta")}
              </a>
              <p className="mt-2 text-xs text-op-muted">{SUPPORT_EMAIL}</p>
            </div>
          </div>

          <div className="flex flex-col rounded-2xl border border-op-border bg-op-surface p-5">
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-op-bg text-op-text">
              <HelpIcon name="printer" />
            </span>
            <h3 className="font-semibold text-op-text">{t("agentTitle")}</h3>
            <p className="mt-1 flex-1 text-sm text-op-muted">{t("agentBody")}</p>
            <div className="mt-4">
              <PrintAgentDownload />
            </div>
            {agentArticleVisible && (
              <div className="mt-3">
                <Link
                  href={`${OPERATOR_HELP_BASE}/${PRINT_AGENT_ARTICLE.category}/${PRINT_AGENT_ARTICLE.slug}`}
                  className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-full border border-op-border px-5 text-sm font-medium text-op-text hover:border-op-text"
                >
                  {t("agentGuideCta")}
                  <HelpIcon name="chevron" className="h-3.5 w-3.5" />
                </Link>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
