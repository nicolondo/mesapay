import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { IconArrowRight, IconMail } from "./Icons";
import { Reveal } from "./Reveal";
import {
  CONTACT_EMAIL,
  ROUTES,
  btnOnDark,
  btnOnDarkGhost,
  demoMailto,
  eyebrow,
} from "./links";

/** Cierre: la demo con la carta del restaurante y el único contacto público. */
export async function FinalCta() {
  const t = await getTranslations("landing");

  return (
    <section className="py-20 sm:py-24 lg:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <Reveal className="relative overflow-hidden rounded-[28px] bg-ink px-6 py-12 text-bone sm:px-12 sm:py-16 lg:px-20 lg:py-24">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-24 -top-32 h-[460px] w-[460px] rounded-full bg-[radial-gradient(closest-side,rgba(201,83,46,0.4),transparent)]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-40 -left-24 h-[420px] w-[420px] rounded-full bg-[radial-gradient(closest-side,rgba(92,107,59,0.3),transparent)]"
          />
          <div className="relative max-w-3xl">
            <p className={`${eyebrow} text-[#E8794F]`}>
              {t("finalCta.eyebrow")}
            </p>
            <h2 className="mt-4 font-display text-[44px] leading-[1.02] tracking-[-0.02em] text-balance sm:text-[64px] lg:text-[76px]">
              {t("finalCta.title")}
            </h2>
            <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-bone/75 sm:text-lg">
              {t("finalCta.body")}
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <a href={demoMailto(t("cta.demoSubject"))} className={btnOnDark}>
                {t("cta.bookDemo")}
                <IconArrowRight size={18} />
              </a>
              <Link href={ROUTES.deck} className={btnOnDarkGhost}>
                {t("cta.seeDeck")}
              </Link>
            </div>
            <p className="mt-8 flex items-start gap-2.5 text-[15px] leading-relaxed text-bone/70">
              <IconMail size={18} className="mt-0.5 shrink-0 text-bone/60" />
              <span>
                {t.rich("finalCta.writeUs", {
                  email: () => (
                    <a
                      href={`mailto:${CONTACT_EMAIL}`}
                      className="font-medium text-bone underline decoration-bone/30 underline-offset-4 hover:decoration-bone"
                    >
                      {CONTACT_EMAIL}
                    </a>
                  ),
                })}
              </span>
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
