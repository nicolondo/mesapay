import { getTranslations } from "next-intl/server";
import {
  IconBox,
  IconCard,
  IconKitchen,
  IconQr,
  IconReceipt,
  IconScale,
} from "./Icons";
import { Reveal } from "./Reveal";
import { eyebrow } from "./links";

const STEPS = [
  { n: 1, Icon: IconQr },
  { n: 2, Icon: IconKitchen },
  { n: 3, Icon: IconCard },
  { n: 4, Icon: IconReceipt },
  { n: 5, Icon: IconBox },
  { n: 6, Icon: IconScale },
] as const;

/**
 * "Todo conectado": la misma venta recorre el sistema de punta a punta.
 * En el celular es una línea de tiempo vertical; en escritorio, una sola
 * fila de seis pasos unidos por una línea.
 */
export async function Flow() {
  const t = await getTranslations("landing.flow");

  return (
    <section className="border-y border-hairline bg-paper">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <Reveal className="max-w-3xl">
          <p className={`${eyebrow} text-terracotta-2`}>{t("eyebrow")}</p>
          <h2 className="mt-4 font-display text-[40px] leading-[1.04] tracking-[-0.02em] text-balance sm:text-[52px]">
            {t("title")}
          </h2>
          <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-ink-3 text-pretty">
            {t("lead")}
          </p>
        </Reveal>

        <ol className="mt-14 grid lg:mt-16 lg:grid-cols-6">
          {STEPS.map(({ n, Icon }, i) => {
            const last = i === STEPS.length - 1;
            return (
              <li key={n} className="relative pb-9 last:pb-0 lg:pb-0 lg:pr-5">
                {!last && (
                  <span
                    aria-hidden
                    className="absolute bottom-0 left-[21px] top-11 w-px bg-hairline-2 lg:left-11 lg:right-0 lg:top-[21px] lg:h-px lg:w-auto"
                  />
                )}
                <Reveal delayMs={i * 70} className="relative flex gap-5 lg:block">
                  <span className="relative z-10 grid h-11 w-11 shrink-0 place-items-center rounded-full border border-hairline-2 bg-ivory text-terracotta-2 shadow-[0_1px_2px_rgba(26,22,19,0.06)]">
                    <Icon size={20} />
                  </span>
                  <div className="pt-1 lg:mt-5 lg:pt-0">
                    <p className="font-mono text-[11px] tracking-[0.14em] text-muted">
                      {String(n).padStart(2, "0")}
                    </p>
                    <p className="mt-1 font-display text-[26px] leading-tight text-ink">
                      {t(`s${n}t`)}
                    </p>
                    <p className="mt-1.5 max-w-[22rem] text-[14.5px] leading-relaxed text-ink-3">
                      {t(`s${n}d`)}
                    </p>
                  </div>
                </Reveal>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
