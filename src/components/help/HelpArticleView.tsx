import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { helpHeadings } from "@/lib/help/markdown";
import { supportMailto } from "@/lib/help/constants";
import type { ResolvedHelpArticle } from "@/lib/help/content";
import type { HelpArticle } from "@/content/help/types";
import { HelpMarkdown } from "./HelpMarkdown";
import { HelpIcon } from "./HelpIcon";
import { HelpSearchLauncher } from "./HelpSearchLauncher";

/**
 * Un artículo de ayuda: migas, título, índice de subtítulos, cuerpo, accesos
 * "Ir a…", relacionados de la misma categoría, fecha de actualización y
 * contacto con soporte. Lo comparten el panel del dueño y la app del mesero;
 * en la app del mesero sólo quedan los enlaces a pantallas del mesero.
 */
export async function HelpArticleView({
  resolved,
  related,
  basePath,
  locale,
  allowHref,
  extra,
  showCategoryCrumb = true,
  showSupport = true,
}: {
  resolved: ResolvedHelpArticle;
  related: HelpArticle[];
  basePath: string;
  locale: Locale;
  allowHref?: (href: string) => boolean;
  extra?: ReactNode;
  showCategoryCrumb?: boolean;
  /** En la app del mesero no se ofrece escribir a soporte: se le pide al encargado. */
  showSupport?: boolean;
}) {
  const t = await getTranslations("help");
  const { category, article, blocks } = resolved;
  const toc = helpHeadings(blocks).filter((h) => h.level === 2);
  const links = allowHref ? article.links.filter((l) => allowHref(l.href)) : article.links;
  const updated = formatDate(`${article.updated}T12:00:00Z`, {
    locale,
    timeZone: "UTC",
    dateStyle: "long",
    timeStyle: undefined,
  });
  const labels = {
    tip: t("calloutTip"),
    warning: t("calloutWarning"),
    copy: t("codeCopy"),
    copied: t("codeCopied"),
  };

  const tocList = (
    <ol className="space-y-1.5 text-sm">
      {toc.map((h) => (
        <li key={h.id}>
          <a href={`#${h.id}`} className="text-op-muted hover:text-op-text">
            {h.text}
          </a>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <nav aria-label={t("breadcrumbLabel")} className="mb-4 flex flex-wrap items-center gap-1.5 text-sm text-op-muted">
        <Link href={basePath} className="hover:text-op-text hover:underline">
          {t("breadcrumbHelp")}
        </Link>
        {showCategoryCrumb && (
          <>
            <HelpIcon name="chevron" className="h-3.5 w-3.5" />
            <Link href={`${basePath}/${category.id}`} className="hover:text-op-text hover:underline">
              {category.title}
            </Link>
          </>
        )}
      </nav>

      <div className="mb-6 max-w-md">
        <HelpSearchLauncher action={basePath} />
      </div>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_220px] lg:gap-12">
        <article className="min-w-0">
          <header className="mb-6">
            <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-op-text sm:text-3xl">
              {article.title}
            </h1>
            <p className="mt-3 text-base leading-relaxed text-op-muted">{article.summary}</p>
            <p className="mt-3 text-xs text-op-muted">{t("updatedOn", { date: updated })}</p>
          </header>

          {toc.length > 1 && (
            <details className="mb-6 rounded-xl border border-op-border bg-op-surface px-4 py-3 lg:hidden">
              <summary className="cursor-pointer text-sm font-medium text-op-text">
                {t("tocTitle")}
              </summary>
              <div className="mt-3">{tocList}</div>
            </details>
          )}

          {extra && <div className="mb-6">{extra}</div>}

          <HelpMarkdown blocks={blocks} labels={labels} allowHref={allowHref} />

          {links.length > 0 && (
            <section aria-labelledby="help-goto" className="mt-8">
              <h2 id="help-goto" className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-op-muted">
                {t("goToTitle")}
              </h2>
              <div className="flex flex-wrap gap-2">
                {links.map((l) => (
                  <Link
                    key={l.href + l.label}
                    href={l.href}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full border border-op-border bg-op-surface px-4 text-sm font-medium text-op-text hover:border-op-text"
                  >
                    {l.label}
                    <HelpIcon name="chevron" className="h-3.5 w-3.5" />
                  </Link>
                ))}
              </div>
            </section>
          )}

          <section className="mt-10 rounded-2xl border border-op-border bg-op-surface p-5">
            <h2 className="text-base font-semibold text-op-text">{t("articleSupportTitle")}</h2>
            {showSupport ? (
              <>
                <p className="mt-1 text-sm text-op-muted">{t("articleSupportBody")}</p>
                <a
                  href={supportMailto(t("articleMailSubject", { title: article.title }))}
                  className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-full bg-ink px-5 text-sm font-medium text-bone hover:bg-ink/90"
                >
                  <HelpIcon name="mail" className="h-4 w-4" />
                  {t("articleSupportCta")}
                </a>
              </>
            ) : (
              <p className="mt-1 text-sm text-op-muted">{t("meseroAskManager")}</p>
            )}
          </section>

          {related.length > 0 && (
            <section aria-labelledby="help-related" className="mt-10">
              <h2 id="help-related" className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-op-muted">
                {t("relatedTitle")}
              </h2>
              <ul className="overflow-hidden rounded-2xl border border-op-border bg-op-surface">
                {related.map((a) => (
                  <li key={a.slug} className="border-b border-op-border last:border-b-0">
                    <Link
                      href={`${basePath}/${category.id}/${a.slug}`}
                      className="flex items-start gap-3 px-4 py-3 hover:bg-op-bg"
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
          )}
        </article>

        {toc.length > 1 && (
          <aside className="hidden lg:block">
            <div className="sticky top-6">
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-op-muted">
                {t("tocTitle")}
              </h2>
              {tocList}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
