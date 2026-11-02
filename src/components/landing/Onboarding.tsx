import { getTranslations } from "next-intl/server";
import { IconPhone, IconTablet } from "./Icons";
import { Reveal } from "./Reveal";
import { SECTION, eyebrow } from "./links";

const STEPS = [1, 2, 3] as const;

/**
 * "Listo en una semana": los tres pasos de implementación de la
 * presentación y la frase de equipos (tablet para cocina + celulares de
 * los meseros; nunca "sin equipos").
 */
export async function Onboarding() {
  const t = await getTranslations("landing.start");

  return (
    <section
      id={SECTION.start}
      className="scroll-mt-16 py-20 sm:py-24 lg:py-32"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <Reveal className="max-w-3xl">
          <p className={`${eyebrow} text-terracotta-2`}>{t("eyebrow")}</p>
          <h2 className="mt-4 font-display text-[44px] leading-[1.02] tracking-[-0.02em] sm:text-[60px]">
            {t("title")}
          </h2>
          <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-ink-3">
            {t("lead")}
          </p>
        </Reveal>

        <ol className="mt-12 grid gap-4 md:grid-cols-3 lg:mt-16 lg:gap-6">
          {STEPS.map((n, i) => (
            <li key={n}>
              <Reveal
                delayMs={i * 80}
                className="flex h-full flex-col rounded-[22px] border border-hairline bg-ivory p-6 sm:p-8"
              >
                <span className="font-display text-[64px] leading-[0.9] text-terracotta-2 sm:text-[72px]">
                  {n}
                </span>
                <p className="mt-6 font-display text-[26px] leading-tight text-ink">
                  {t(`s${n}t`)}
                </p>
                <p className="mt-2 text-[15px] leading-relaxed text-ink-3">
                  {t(`s${n}d`)}
                </p>
              </Reveal>
            </li>
          ))}
        </ol>

        <Reveal className="mt-4 lg:mt-6">
          <div className="flex flex-col gap-5 rounded-[22px] bg-ink p-6 text-bone sm:flex-row sm:items-center sm:gap-8 sm:p-8">
            <div aria-hidden className="flex shrink-0 items-end gap-2 text-[#E8794F]">
              <IconTablet size={40} />
              <IconPhone size={30} />
              <IconPhone size={30} />
            </div>
            <div>
              <p className="font-display text-[24px] leading-snug sm:text-[28px]">
                {t("devicesTitle")}
              </p>
              <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-bone/70">
                {t("devicesBody")}
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
