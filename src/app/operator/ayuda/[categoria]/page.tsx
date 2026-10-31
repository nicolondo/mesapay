import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { helpCategory } from "@/lib/help/content";
import { OPERATOR_HELP_BASE } from "@/lib/help/constants";
import { HelpIcon } from "@/components/help/HelpIcon";
import { HelpSearchLauncher } from "@/components/help/HelpSearchLauncher";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ categoria: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { categoria } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations("help");
  const category = helpCategory(locale, categoria);
  return { title: category ? `${category.title} · ${t("metaTitle")}` : t("metaTitle") };
}

/** Una categoría de la ayuda: la lista de sus artículos. */
export default async function HelpCategoryPage({ params }: Params) {
  const { categoria } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations("help");
  const category = helpCategory(locale, categoria);
  if (!category) notFound();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <nav aria-label={t("breadcrumbLabel")} className="mb-4 text-sm text-op-muted">
        <Link href={OPERATOR_HELP_BASE} className="inline-flex items-center gap-1 hover:text-op-text hover:underline">
          <HelpIcon name="back" className="h-3.5 w-3.5" />
          {t("breadcrumbHelp")}
        </Link>
      </nav>

      <header className="mb-6 flex items-start gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-op-border bg-op-surface text-op-text">
          <HelpIcon name={category.icon} className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <h1 className="text-[26px] font-semibold leading-tight tracking-tight text-op-text sm:text-3xl">
            {category.title}
          </h1>
          <p className="mt-2 text-base leading-relaxed text-op-muted">{category.description}</p>
          <p className="mt-2 text-xs font-medium text-op-muted">
            {t("categoryArticleCount", { count: category.articles.length })}
          </p>
        </div>
      </header>

      <div className="mb-6">
        <HelpSearchLauncher action={OPERATOR_HELP_BASE} />
      </div>

      <ul className="overflow-hidden rounded-2xl border border-op-border bg-op-surface">
        {category.articles.map((a) => (
          <li key={a.slug} className="border-b border-op-border last:border-b-0">
            <Link
              href={`${OPERATOR_HELP_BASE}/${category.id}/${a.slug}`}
              className="flex items-start gap-3 px-4 py-4 hover:bg-op-bg"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-op-text">{a.title}</span>
                <span className="mt-1 block text-sm leading-relaxed text-op-muted">{a.summary}</span>
              </span>
              <HelpIcon name="chevron" className="mt-1 h-4 w-4 shrink-0 text-op-muted" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
