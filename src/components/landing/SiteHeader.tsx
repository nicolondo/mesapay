import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { BrandMark } from "./BrandMark";
import { ROUTES, SECTION, btnHeader, demoMailto } from "./links";

/**
 * Cabecera fija y ligera. En el celular sólo caben la marca, "Ingresar" y
 * el botón de demo (con la etiqueta corta); las anclas a secciones
 * aparecen desde escritorio. Sin JS de cliente.
 */
export async function SiteHeader() {
  const t = await getTranslations("landing");
  const anchors = [
    { id: SECTION.product, label: t("nav.product") },
    { id: SECTION.start, label: t("nav.start") },
    { id: SECTION.plans, label: t("nav.plans") },
    { id: SECTION.faq, label: t("nav.faq") },
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-hairline/70 bg-bone/85 backdrop-blur-xl supports-[backdrop-filter]:bg-bone/75">
      <a
        href={`#${SECTION.content}`}
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-[var(--radius-btn)] focus:bg-ink focus:px-4 focus:py-2 focus:text-bone"
      >
        {t("nav.skip")}
      </a>
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:h-16 sm:px-6 lg:px-8">
        <Link
          href="/"
          aria-label={t("nav.home")}
          className="flex shrink-0 items-center gap-2.5 rounded-[var(--radius-btn)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"
        >
          <BrandMark />
          <span className="font-display text-[22px] leading-none tracking-[-0.01em]">
            {"MESAPAY"}
          </span>
        </Link>

        <nav
          aria-label={t("nav.label")}
          className="hidden items-center gap-8 text-[14px] text-ink-3 lg:flex"
        >
          {anchors.map((a) => (
            <a
              key={a.id}
              href={`#${a.id}`}
              className="transition-colors hover:text-ink"
            >
              {a.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-1 sm:gap-2">
          <Link
            href={ROUTES.signin}
            className="inline-flex h-10 items-center rounded-[var(--radius-btn)] px-3 text-[14px] text-ink transition-colors hover:bg-ink/[0.06]"
          >
            {t("nav.signIn")}
          </Link>
          <a
            href={demoMailto(t("cta.demoSubject"))}
            aria-label={t("nav.bookDemo")}
            className={btnHeader}
          >
            <span className="sm:hidden">{t("nav.bookDemoShort")}</span>
            <span className="hidden sm:inline">{t("nav.bookDemo")}</span>
          </a>
        </div>
      </div>
    </header>
  );
}
