import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { IconArrowRight, IconCheck } from "./Icons";
import { Reveal } from "./Reveal";
import {
  ROUTES,
  SECTION,
  btnPrimary,
  btnSecondary,
  demoMailto,
  eyebrow,
} from "./links";

const POINTS = ["point1", "point2", "point3"] as const;

/**
 * Planes SIN precios publicados (igual que la presentación): mensualidad
 * fija por local, propuesta en la demo, y la prueba gratis con el número
 * de días del catálogo de planes (`PlanConfig.trial`: 30 días).
 */
export async function Plans() {
  const t = await getTranslations("landing");

  return (
    <section
      id={SECTION.plans}
      className="scroll-mt-16 pb-20 sm:pb-24 lg:pb-32"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <Reveal className="overflow-hidden rounded-[28px] border border-hairline bg-ivory lg:grid lg:grid-cols-12">
          <div className="p-6 sm:p-10 lg:col-span-7 lg:p-14">
            <p className={`${eyebrow} text-terracotta-2`}>
              {t("plans.eyebrow")}
            </p>
            <h2 className="mt-4 font-display text-[36px] leading-[1.05] tracking-[-0.02em] text-balance sm:text-[48px]">
              {t("plans.title")}
            </h2>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-ink-3">
              {t("plans.body")}
            </p>
            <ul className="mt-8 space-y-3">
              {POINTS.map((p) => (
                <li key={p} className="flex items-center gap-3 text-[15.5px] text-ink-2">
                  <span
                    aria-hidden
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink text-bone"
                  >
                    <IconCheck size={13} />
                  </span>
                  {t(`plans.${p}`)}
                </li>
              ))}
            </ul>
            <div className="mt-10">
              <a
                href={demoMailto(t("cta.demoSubject"))}
                className={`${btnPrimary} w-full sm:w-auto`}
              >
                {t("cta.bookDemo")}
                <IconArrowRight size={18} />
              </a>
            </div>
          </div>

          <div className="relative flex flex-col justify-between gap-8 border-t border-hairline bg-cream p-6 sm:p-10 lg:col-span-5 lg:border-l lg:border-t-0 lg:p-14">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 grid-bg opacity-50"
            />
            <div className="relative">
              <p className={`${eyebrow} text-muted`}>
                {t("plans.trialEyebrow")}
              </p>
              <p className="mt-4 font-display text-[72px] leading-[0.9] tracking-[-0.02em] text-ink sm:text-[88px]">
                {t("plans.trialDays")}
              </p>
              <p className="mt-5 max-w-sm text-[15.5px] leading-relaxed text-ink-3">
                {t("plans.trialBody")}
              </p>
            </div>
            <div className="relative">
              <Link href={ROUTES.signup} className={`${btnSecondary} w-full`}>
                {t("cta.createAccount")}
              </Link>
              <p className="mt-4 text-center text-[14px] text-muted">
                {t.rich("plans.haveAccount", {
                  link: (chunks) => (
                    <Link
                      href={ROUTES.signin}
                      className="font-medium text-ink underline decoration-hairline-2 underline-offset-4 hover:decoration-ink"
                    >
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
