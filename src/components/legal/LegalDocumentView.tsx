import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { helpHeadings, parseHelpMarkdown } from "@/lib/help/markdown";
import { HelpMarkdown } from "@/components/help/HelpMarkdown";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import {
  LEGAL_CONTACT_EMAIL,
  LEGAL_DOCUMENTS,
  LEGAL_PATHS,
  legalBody,
  type LegalDocumentId,
} from "@/content/legal";

/**
 * Un documento legal público (/privacidad o /terminos): cabecera con el
 * selector de idioma, título, fecha de la última versión, índice de
 * secciones y el cuerpo pintado con el mismo renderizador del centro de
 * ayuda (sin HTML crudo). Al final, el contacto y el enlace al otro
 * documento. No necesita sesión ni comercio.
 */
export async function LegalDocumentView({
  id,
  locale,
}: {
  id: LegalDocumentId;
  locale: Locale;
}) {
  const t = await getTranslations("legal");
  const th = await getTranslations("help");
  const doc = LEGAL_DOCUMENTS[id];
  const blocks = parseHelpMarkdown(legalBody(doc, locale));
  const toc = helpHeadings(blocks).filter((h) => h.level === 2);
  const other: LegalDocumentId = id === "privacidad" ? "terminos" : "privacidad";
  const title = id === "privacidad" ? t("privacyTitle") : t("termsTitle");
  const otherLabel = other === "privacidad" ? t("seeAlsoPrivacy") : t("seeAlsoTerms");
  const updated = formatDate(`${doc.updatedAt}T12:00:00Z`, {
    locale,
    timeZone: "UTC",
    dateStyle: "long",
    timeStyle: undefined,
  });
  const labels = {
    tip: th("calloutTip"),
    warning: th("calloutWarning"),
    copy: th("codeCopy"),
    copied: th("codeCopied"),
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

  const pill =
    "inline-flex min-h-[44px] items-center rounded-full border border-op-border bg-op-surface px-4 text-sm font-medium text-op-text hover:border-op-text";

  return (
    <div className="flex min-h-screen flex-col bg-op-bg text-op-text">
      <header className="border-b border-op-border bg-op-surface">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="font-display text-xl tracking-tight text-op-text">
            {"MESAPAY"}
          </Link>
          <LocaleSwitcher />
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_220px] lg:gap-12">
          <article className="min-w-0 max-w-3xl">
            <header className="mb-8">
              <p className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-op-muted">
                {t("eyebrow")}
              </p>
              <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-op-text sm:text-4xl">
                {title}
              </h1>
              <p className="mt-3 text-sm text-op-muted">{t("updatedOn", { date: updated })}</p>
              <p className="mt-1 text-sm text-op-muted">{t("languageNote")}</p>
            </header>

            {toc.length > 1 && (
              <details className="mb-8 rounded-xl border border-op-border bg-op-surface px-4 py-3 lg:hidden">
                <summary className="cursor-pointer text-sm font-medium text-op-text">
                  {t("tocTitle")}
                </summary>
                <div className="mt-3">{tocList}</div>
              </details>
            )}

            <HelpMarkdown blocks={blocks} labels={labels} />

            <section className="mt-10 rounded-2xl border border-op-border bg-op-surface p-5">
              <h2 className="text-base font-semibold text-op-text">{t("contactTitle")}</h2>
              <p className="mt-1 text-sm text-op-muted">
                {t.rich("contactBody", {
                  email: () => (
                    <a
                      href={`mailto:${LEGAL_CONTACT_EMAIL}`}
                      className="font-medium text-op-accent underline underline-offset-4 hover:text-op-text"
                    >
                      {LEGAL_CONTACT_EMAIL}
                    </a>
                  ),
                })}
              </p>
            </section>

            <nav aria-label={t("linksLabel")} className="mt-8 flex flex-wrap gap-2">
              <Link href={LEGAL_PATHS[other]} className={pill}>
                {otherLabel}
              </Link>
              <Link href="/" className={pill}>
                {t("backHome")}
              </Link>
            </nav>
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
      </main>
    </div>
  );
}
