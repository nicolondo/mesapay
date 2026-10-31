import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { helpArticle, relatedHelpArticles } from "@/lib/help/content";
import { OPERATOR_HELP_BASE } from "@/lib/help/constants";
import { HelpArticleView } from "@/components/help/HelpArticleView";
import { articleExtra } from "@/components/help/articleExtras";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ categoria: string; slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { categoria, slug } = await params;
  const locale = (await getLocale()) as Locale;
  const t = await getTranslations("help");
  const resolved = helpArticle(locale, categoria, slug);
  return {
    title: resolved ? `${resolved.article.title} · ${t("metaTitle")}` : t("metaTitle"),
  };
}

/** Un artículo de la ayuda, en el panel del dueño. */
export default async function HelpArticlePage({ params }: Params) {
  const { categoria, slug } = await params;
  const locale = (await getLocale()) as Locale;
  const resolved = helpArticle(locale, categoria, slug);
  if (!resolved) notFound();

  return (
    <HelpArticleView
      resolved={resolved}
      related={relatedHelpArticles(resolved.category, resolved.article)}
      basePath={OPERATOR_HELP_BASE}
      locale={locale}
      extra={articleExtra(resolved.category.id, resolved.article.slug)}
    />
  );
}
