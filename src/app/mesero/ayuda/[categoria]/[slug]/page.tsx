import { notFound } from "next/navigation";
import { getLocale } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { helpArticle, relatedHelpArticles } from "@/lib/help/content";
import { MESERO_HELP_BASE } from "@/lib/help/constants";
import { HelpArticleView } from "@/components/help/HelpArticleView";

export const dynamic = "force-dynamic";

/**
 * Un artículo de ayuda dentro de la app del mesero. Sólo abre artículos con
 * audiencia "mesero", y sólo deja como enlace lo que lleva a pantallas del
 * mesero (el panel del dueño lo rebotaría).
 */
const meseroOnly = (href: string) => href === "/mesero" || href.startsWith("/mesero/");

export default async function MeseroHelpArticlePage({
  params,
}: {
  params: Promise<{ categoria: string; slug: string }>;
}) {
  const { categoria, slug } = await params;
  const locale = (await getLocale()) as Locale;
  const resolved = helpArticle(locale, categoria, slug, "mesero");
  if (!resolved) notFound();

  return (
    <HelpArticleView
      resolved={resolved}
      related={relatedHelpArticles(resolved.category, resolved.article, { audience: "mesero" })}
      basePath={MESERO_HELP_BASE}
      locale={locale}
      allowHref={meseroOnly}
      showCategoryCrumb={false}
      showSupport={false}
    />
  );
}
