import { getTranslations } from "next-intl/server";
import { IconArrowDown } from "./Icons";
import { Reveal } from "./Reveal";
import { SECTION, eyebrow } from "./links";

const PAINS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"] as const;

/** "¿Te suena?": los ocho dolores de la presentación, en tinta. */
export async function Pains() {
  const t = await getTranslations("landing.pains");

  return (
    <section className="relative overflow-hidden bg-ink text-bone">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-40 -top-40 h-[520px] w-[520px] rounded-full bg-[radial-gradient(closest-side,rgba(201,83,46,0.28),transparent)]"
      />
      <div className="relative mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <div className="grid gap-10 lg:grid-cols-12 lg:gap-12">
          <Reveal className="lg:col-span-4">
            <p className={`${eyebrow} text-[#E8794F]`}>{t("eyebrow")}</p>
            <h2 className="mt-4 font-display text-[48px] leading-[1] tracking-[-0.02em] sm:text-[60px]">
              {t("title")}
            </h2>
            <p className="mt-5 max-w-sm text-[16px] leading-relaxed text-bone/70">
              {t("lead")}
            </p>
          </Reveal>

          <ol className="grid gap-px overflow-hidden rounded-[20px] border border-bone/10 bg-bone/10 sm:grid-cols-2 lg:col-span-8">
            {PAINS.map((key, i) => (
              <li key={key} className="flex gap-4 bg-ink p-5 sm:p-6">
                <span className="pt-1.5 font-mono text-[11px] tracking-[0.12em] text-[#E8794F]">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <p className="font-display text-[22px] leading-[1.22] text-bone sm:text-[23px]">
                  {t(key)}
                </p>
              </li>
            ))}
          </ol>
        </div>

        <Reveal className="mt-12 flex flex-col gap-5 border-t border-bone/10 pt-10 sm:flex-row sm:items-center sm:justify-between">
          <p className="font-display text-[34px] leading-[1.05] tracking-[-0.01em] sm:text-[40px]">
            {t("closing")}
          </p>
          <a
            href={`#${SECTION.product}`}
            className="inline-flex items-center gap-2 self-start rounded-[var(--radius-btn)] text-[15px] font-medium text-bone underline decoration-bone/30 underline-offset-[6px] transition-colors hover:decoration-bone sm:self-auto"
          >
            {t("closingLink")}
            <IconArrowDown size={17} />
          </a>
        </Reveal>
      </div>
    </section>
  );
}
