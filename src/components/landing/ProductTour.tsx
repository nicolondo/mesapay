import { getTranslations } from "next-intl/server";
import { PhoneFrame, TabletFrame } from "./Devices";
import {
  IconBook,
  IconBuilding,
  IconCalendar,
  IconBag,
  IconCheck,
  IconGlobe,
  IconScan,
  IconShield,
  IconTablet,
  IconUsers,
} from "./Icons";
import { Reveal } from "./Reveal";
import { SECTION, eyebrow } from "./links";

/**
 * Recorrido del producto: un bloque por área del restaurante, cada uno con
 * el dolor que resuelve, lo que hace (sacado de la presentación y del
 * centro de ayuda) y capturas reales del restaurante de demostración.
 * Los bloques alternan el lado de la captura; cocina va a lo ancho porque
 * la tablet necesita espacio para leerse.
 */

type Tone = "cream" | "clay" | "paper" | "sage" | "ink";

type Block = {
  key: string;
  features: number;
  tone: Tone;
  /** Capturas de celular (1 o 2) o la tablet de cocina. */
  phones?: readonly string[];
  tablet?: string;
  note?: boolean;
};

const BLOCKS: readonly Block[] = [
  {
    key: "table",
    features: 4,
    tone: "cream",
    phones: ["/landing/01-carta-comensal.webp", "/landing/02-pago-comensal.webp"],
  },
  {
    key: "waiters",
    features: 4,
    tone: "clay",
    phones: ["/landing/05-mesero.webp", "/landing/03-mesas.webp"],
    note: true,
  },
  {
    key: "kitchen",
    features: 4,
    tone: "paper",
    tablet: "/landing/04-cocina-tablet.webp",
  },
  {
    key: "cash",
    features: 4,
    tone: "cream",
    phones: ["/landing/06-cierre.webp", "/landing/06b-cierre-por-metodo.webp"],
  },
  {
    key: "foodcost",
    features: 4,
    tone: "sage",
    phones: ["/landing/07-recetas.webp"],
  },
  {
    key: "accounting",
    features: 4,
    tone: "ink",
    phones: ["/landing/08-estado-resultado.webp"],
  },
  {
    key: "pulso",
    features: 3,
    tone: "clay",
    phones: ["/landing/09-pulso.webp", "/landing/10-resumen.webp"],
  },
];

const TONE: Record<Tone, string> = {
  cream: "bg-cream",
  clay: "bg-terracotta-soft/70",
  paper: "bg-paper border border-hairline",
  sage: "bg-[#E6E7DA]",
  ink: "bg-ink",
};

const MORE = [
  { key: "payroll", Icon: IconUsers },
  { key: "reservations", Icon: IconCalendar },
  { key: "pickup", Icon: IconBag },
  { key: "languages", Icon: IconGlobe },
  { key: "import", Icon: IconScan },
  { key: "branches", Icon: IconBuilding },
  { key: "backups", Icon: IconShield },
  { key: "help", Icon: IconBook },
] as const;

export async function ProductTour() {
  const t = await getTranslations("landing.tour");

  return (
    <section
      id={SECTION.product}
      className="scroll-mt-16 py-20 sm:py-24 lg:py-32"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
        <Reveal className="max-w-3xl">
          <p className={`${eyebrow} text-terracotta-2`}>{t("eyebrow")}</p>
          <h2 className="mt-4 font-display text-[40px] leading-[1.04] tracking-[-0.02em] text-balance sm:text-[52px] lg:text-[60px]">
            {t("title")}
          </h2>
          <p className="mt-6 max-w-2xl text-[17px] leading-relaxed text-ink-3 text-pretty">
            {t("lead")}
          </p>
        </Reveal>

        <div className="mt-14 space-y-20 sm:mt-20 sm:space-y-24 lg:mt-28 lg:space-y-36">
          {BLOCKS.map((block, i) => (
            <TourBlock
              key={block.key}
              block={block}
              index={i + 1}
              reverse={i % 2 === 1}
              t={t}
            />
          ))}
        </div>

        <div className="mt-24 border-t border-hairline pt-16 lg:mt-36 lg:pt-20">
          <Reveal className="max-w-2xl">
            <p className={`${eyebrow} text-terracotta-2`}>
              {t("more.eyebrow")}
            </p>
            <h3 className="mt-4 font-display text-[34px] leading-[1.06] tracking-[-0.015em] text-balance sm:text-[44px]">
              {t("more.title")}
            </h3>
          </Reveal>
          <ul className="mt-8 grid gap-3 sm:mt-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-4">
            {MORE.map(({ key, Icon }, i) => (
              <li key={key}>
                <Reveal
                  delayMs={(i % 4) * 60}
                  className="flex h-full gap-4 rounded-[18px] border border-hairline bg-ivory p-4 sm:block sm:p-6"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-cream text-terracotta-2">
                    <Icon size={20} />
                  </span>
                  <div>
                    <p className="text-[16px] font-medium text-ink sm:mt-4">
                      {t(`more.${key}T`)}
                    </p>
                    <p className="mt-1 text-[14.5px] leading-relaxed text-ink-3 sm:mt-1.5">
                      {t(`more.${key}D`)}
                    </p>
                  </div>
                </Reveal>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** Traductor del namespace `landing.tour` (claves armadas por bloque). */
type T = (key: string) => string;

function TourBlock({
  block,
  index,
  reverse,
  t,
}: {
  block: Block;
  index: number;
  reverse: boolean;
  t: T;
}) {
  const k = block.key;
  const header = (
    <>
      <p
        className={`${eyebrow} flex items-center gap-3 text-terracotta-2 max-sm:tracking-[0.14em]`}
      >
        <span>{String(index).padStart(2, "0")}</span>
        <span aria-hidden className="h-px w-8 bg-terracotta-2/40" />
        <span>{t(`${k}.kicker`)}</span>
      </p>
      <p className="mt-5 font-display text-[19px] italic leading-snug text-muted">
        {t(`${k}.pain`)}
      </p>
      <h3 className="mt-2 font-display text-[34px] leading-[1.05] tracking-[-0.015em] text-balance sm:text-[44px] lg:text-[46px]">
        {t(`${k}.title`)}
      </h3>
    </>
  );

  const features = (
    <>
      <ul
        className={
          "grid gap-x-8 gap-y-6 sm:grid-cols-2 " +
          (block.tablet ? "" : "lg:grid-cols-1")
        }
      >
        {Array.from({ length: block.features }, (_, j) => j + 1).map((n) => (
          <li key={n} className="flex gap-3.5">
            <span
              aria-hidden
              className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-terracotta-soft text-terracotta-2"
            >
              <IconCheck size={13} />
            </span>
            <div>
              <p className="text-[16px] font-medium leading-snug text-ink">
                {t(`${k}.f${n}t`)}
              </p>
              <p className="mt-1.5 text-[15px] leading-relaxed text-ink-3">
                {t(`${k}.f${n}d`)}
              </p>
            </div>
          </li>
        ))}
      </ul>
      {block.note && (
        <p className="mt-8 flex items-start gap-3 rounded-[16px] border border-hairline bg-ivory p-4 text-[15px] leading-relaxed text-ink-2">
          <IconTablet size={20} className="mt-0.5 shrink-0 text-terracotta-2" />
          <span className="font-medium">{t(`${k}.note`)}</span>
        </p>
      )}
    </>
  );

  // Cocina: texto arriba (encabezado | puntos) y la tablet a lo ancho.
  if (block.tablet) {
    return (
      <article className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:gap-x-16 lg:gap-y-14">
        <Reveal className="lg:col-start-1 lg:row-start-1">{header}</Reveal>
        <Reveal className="lg:col-span-2 lg:row-start-2">
          <div
            className={`relative overflow-hidden rounded-[24px] px-3 pt-5 sm:rounded-[28px] sm:px-10 sm:pt-12 lg:px-16 lg:pt-14 ${TONE[block.tone]} aspect-[1.5/1] sm:aspect-[1.62/1] lg:aspect-[1.75/1]`}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 grid-bg opacity-70"
            />
            <TabletFrame
              src={block.tablet}
              alt={t(`${k}.shot1`)}
              sizes="(min-width: 1152px) 960px, (min-width: 640px) calc(100vw - 128px), calc(100vw - 56px)"
              className="relative mx-auto max-w-[960px]"
            />
          </div>
        </Reveal>
        <Reveal className="lg:col-start-2 lg:row-start-1 lg:self-end">
          {features}
        </Reveal>
      </article>
    );
  }

  const textCol = reverse ? "lg:col-start-2" : "lg:col-start-1";
  const visualCol = reverse ? "lg:col-start-1" : "lg:col-start-2";
  const cols = reverse
    ? "lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]"
    : "lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]";

  return (
    <article
      className={`grid gap-8 lg:grid-rows-[auto_1fr] lg:gap-x-16 lg:gap-y-10 ${cols}`}
    >
      <Reveal className={`${textCol} lg:row-start-1`}>{header}</Reveal>
      <Reveal
        className={`${visualCol} lg:sticky lg:top-24 lg:row-span-2 lg:row-start-1 lg:self-start`}
      >
        <PhonesPanel block={block} t={t} />
      </Reveal>
      <Reveal className={`${textCol} lg:row-start-2`}>{features}</Reveal>
    </article>
  );
}

function PhonesPanel({ block, t }: { block: Block; t: T }) {
  const phones = block.phones ?? [];
  const dark = block.tone === "ink";
  const panel = `relative overflow-hidden rounded-[24px] sm:rounded-[28px] ${TONE[block.tone]} aspect-[1/1.02] sm:aspect-[1.2/1] lg:aspect-[1/0.95]`;
  const deco = (
    <div
      aria-hidden
      className={
        "pointer-events-none absolute inset-0 " +
        (dark
          ? "bg-[radial-gradient(ellipse_60%_50%_at_50%_0%,rgba(201,83,46,0.35),transparent)]"
          : "grid-bg opacity-60 [mask-image:linear-gradient(to_bottom,black,transparent_85%)]")
      }
    />
  );

  if (phones.length === 1) {
    return (
      <div className={panel}>
        {deco}
        <div className="absolute left-1/2 top-[8%] w-[54%] -translate-x-1/2 sm:w-[38%] lg:w-[50%]">
          <PhoneFrame
            src={phones[0]}
            alt={t(`${block.key}.shot1`)}
            tone={dark ? "dark" : "light"}
            sizes="(min-width: 1024px) 290px, (min-width: 640px) 230px, 54vw"
          />
        </div>
      </div>
    );
  }

  return (
    <div className={panel}>
      {deco}
      <div className="absolute left-[4%] top-[8%] w-[46%] sm:left-[13%] sm:w-[35%] lg:left-[6%] lg:w-[43%]">
        <PhoneFrame
          src={phones[0]}
          alt={t(`${block.key}.shot1`)}
          tone={dark ? "dark" : "light"}
          sizes="(min-width: 1024px) 250px, (min-width: 640px) 210px, 46vw"
        />
      </div>
      <div className="absolute right-[4%] top-[17%] z-10 w-[46%] sm:right-[13%] sm:w-[35%] lg:right-[6%] lg:w-[43%]">
        <PhoneFrame
          src={phones[1]}
          alt={t(`${block.key}.shot2`)}
          tone={dark ? "dark" : "light"}
          sizes="(min-width: 1024px) 250px, (min-width: 640px) 210px, 46vw"
        />
      </div>
    </div>
  );
}
