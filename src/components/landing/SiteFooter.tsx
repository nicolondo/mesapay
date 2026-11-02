import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { BrandMark } from "./BrandMark";
import { CONTACT_EMAIL, ROUTES, SECTION, demoMailto, eyebrow } from "./links";

const linkCls = "text-ink-3 transition-colors hover:text-ink";

/** Pie: producto, cómo empezar, contacto, idioma y enlaces legales. */
export async function SiteFooter() {
  const t = await getTranslations("landing");
  const tl = await getTranslations("legal");

  return (
    <footer className="border-t border-hairline bg-paper">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-x-6 gap-y-10 px-4 py-14 sm:px-6 lg:grid-cols-12 lg:gap-8 lg:px-8 lg:py-16">
        <div className="col-span-2 lg:col-span-5">
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <span className="font-display text-[22px] leading-none">
              {"MESAPAY"}
            </span>
          </div>
          <p className="mt-4 max-w-sm text-[15px] leading-relaxed text-ink-3">
            {t("footer.tagline")}
          </p>
          <LocaleSwitcher className="mt-6" />
        </div>

        <nav aria-labelledby="footer-product" className="lg:col-span-2">
          <p id="footer-product" className={`${eyebrow} mb-4 text-muted`}>
            {t("footer.product")}
          </p>
          <ul className="space-y-2.5 text-[15px]">
            <li>
              <a href={`#${SECTION.product}`} className={linkCls}>
                {t("nav.product")}
              </a>
            </li>
            <li>
              <a href={`#${SECTION.start}`} className={linkCls}>
                {t("nav.start")}
              </a>
            </li>
            <li>
              <a href={`#${SECTION.plans}`} className={linkCls}>
                {t("nav.plans")}
              </a>
            </li>
            <li>
              <a href={`#${SECTION.faq}`} className={linkCls}>
                {t("nav.faq")}
              </a>
            </li>
          </ul>
        </nav>

        <nav aria-labelledby="footer-start" className="lg:col-span-2">
          <p id="footer-start" className={`${eyebrow} mb-4 text-muted`}>
            {t("footer.start")}
          </p>
          <ul className="space-y-2.5 text-[15px]">
            <li>
              <a href={demoMailto(t("cta.demoSubject"))} className={linkCls}>
                {t("cta.bookDemo")}
              </a>
            </li>
            <li>
              <Link href={ROUTES.deck} className={linkCls}>
                {t("cta.seeDeck")}
              </Link>
            </li>
            <li>
              <Link href={ROUTES.signup} className={linkCls}>
                {t("cta.createAccount")}
              </Link>
            </li>
            <li>
              <Link href={ROUTES.signin} className={linkCls}>
                {t("cta.signIn")}
              </Link>
            </li>
          </ul>
        </nav>

        <div className="col-span-2 lg:col-span-3">
          <p className={`${eyebrow} mb-4 text-muted`}>{t("footer.contact")}</p>
          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className="text-[15px] font-medium text-ink underline decoration-hairline-2 underline-offset-4 hover:decoration-ink"
          >
            {CONTACT_EMAIL}
          </a>
        </div>
      </div>

      <div className="border-t border-hairline">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 font-mono text-[11px] uppercase tracking-[0.12em] text-muted sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <span>
            {t("footer.copyright", {
              year: String(new Date().getFullYear()),
            })}
          </span>
          <nav
            aria-label={tl("linksLabel")}
            className="flex flex-wrap items-center gap-x-5 gap-y-2"
          >
            <Link href={ROUTES.privacy} className="hover:text-ink">
              {tl("footerPrivacy")}
            </Link>
            <Link href={ROUTES.terms} className="hover:text-ink">
              {tl("footerTerms")}
            </Link>
          </nav>
          <span>{t("footer.madeFor")}</span>
        </div>
      </div>
    </footer>
  );
}
