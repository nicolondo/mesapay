import { getTranslations } from "next-intl/server";
import { IconPlus } from "./Icons";
import { Reveal } from "./Reveal";
import { SECTION, eyebrow } from "./links";

const FAQ_KEYS = [1, 2, 3, 4, 5, 6] as const;

export type LandingFaq = { q: string; a: string };

/**
 * Preguntas frecuentes en el idioma del visitante. Una sola fuente para
 * la sección visible y para el JSON-LD (schema.org FAQPage), así los
 * resultados enriquecidos de Google nunca se desincronizan del contenido.
 */
export async function getLandingFaqs(): Promise<LandingFaq[]> {
  const t = await getTranslations("landing.faq");
  return FAQ_KEYS.map((n) => ({ q: t(`q${n}`), a: t(`a${n}`) }));
}

/** Acordeón nativo (<details>): sin JS de cliente. */
export async function Faq() {
  const t = await getTranslations("landing.faq");
  const faqs = await getLandingFaqs();

  return (
    <section
      id={SECTION.faq}
      className="scroll-mt-16 border-y border-hairline bg-paper"
    >
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-20 sm:px-6 lg:grid-cols-12 lg:gap-12 lg:px-8 lg:py-28">
        <Reveal className="lg:col-span-4">
          <p className={`${eyebrow} text-terracotta-2`}>{t("eyebrow")}</p>
          <h2 className="mt-4 font-display text-[40px] leading-[1.04] tracking-[-0.02em] text-balance sm:text-[48px]">
            {t("title")}
          </h2>
        </Reveal>

        <div className="lg:col-span-8">
          <ul className="divide-y divide-hairline border-y border-hairline">
            {faqs.map((f, i) => (
              <li key={i}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-start justify-between gap-6 py-5 text-left font-display text-[22px] leading-snug text-ink transition-colors hover:text-ink-3 sm:text-[24px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <span
                      aria-hidden
                      className="mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full border border-hairline-2 text-ink transition-transform duration-200 group-open:rotate-45 motion-reduce:transition-none"
                    >
                      <IconPlus size={15} />
                    </span>
                  </summary>
                  <p className="max-w-2xl pb-6 pr-12 text-[15.5px] leading-relaxed text-ink-3">
                    {f.a}
                  </p>
                </details>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
