import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PhoneFrame } from "./Devices";
import {
  IconArrowRight,
  IconBox,
  IconCard,
  IconKitchen,
  IconLedger,
  IconPhone,
  IconQr,
  IconReceipt,
  IconSpark,
  IconUsers,
} from "./Icons";
import { ROUTES, btnPrimary, btnSecondary, demoMailto, eyebrow } from "./links";

const MODULES = [
  { key: "qr", Icon: IconQr },
  { key: "kitchen", Icon: IconKitchen },
  { key: "waiter", Icon: IconPhone },
  { key: "payments", Icon: IconCard },
  { key: "dian", Icon: IconReceipt },
  { key: "inventory", Icon: IconBox },
  { key: "payroll", Icon: IconUsers },
  { key: "accounting", Icon: IconLedger },
  { key: "pulso", Icon: IconSpark },
] as const;

/**
 * Hero: el titular de la presentación comercial, las dos llamadas a la
 * acción y tres pantallas reales (comensal, mesero, dueño) que cuentan
 * "un solo sistema" sin necesidad de leer. La animación de entrada es
 * CSS puro (.fade-up), que se apaga con prefers-reduced-motion.
 */
export async function Hero() {
  const t = await getTranslations("landing");

  return (
    <section className="relative overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 grain" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 grid-bg opacity-60 [mask-image:radial-gradient(ellipse_70%_60%_at_70%_35%,black,transparent)]"
      />

      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pb-14 pt-10 sm:px-6 sm:pt-14 lg:grid-cols-12 lg:gap-8 lg:px-8 lg:pb-20 lg:pt-20">
        <div className="lg:col-span-6">
          <p
            className={`${eyebrow} inline-flex items-center gap-2.5 text-terracotta-2 fade-up`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-terracotta" />
            {t("hero.eyebrow")}
          </p>
          <h1
            className="mt-5 font-display text-[44px] leading-[1.02] tracking-[-0.02em] text-balance sm:text-[60px] lg:text-[68px] xl:text-[76px] fade-up"
            style={{ animationDelay: "60ms" }}
          >
            {t.rich("hero.title", {
              em: (chunks) => (
                <em className="italic text-terracotta-2">{chunks}</em>
              ),
            })}
          </h1>
          <p
            className="mt-6 max-w-xl text-[17px] leading-relaxed text-ink-3 text-pretty sm:text-lg fade-up"
            style={{ animationDelay: "140ms" }}
          >
            {t("hero.lead")}
          </p>
          <div
            className="mt-8 flex flex-col gap-3 sm:flex-row fade-up"
            style={{ animationDelay: "220ms" }}
          >
            <a href={demoMailto(t("cta.demoSubject"))} className={btnPrimary}>
              {t("cta.bookDemo")}
              <IconArrowRight size={18} />
            </a>
            <Link href={ROUTES.deck} className={btnSecondary}>
              {t("cta.seeDeck")}
            </Link>
          </div>
          <p
            className="mt-5 text-[14px] leading-relaxed text-muted fade-up"
            style={{ animationDelay: "300ms" }}
          >
            {t.rich("hero.trial", {
              link: (chunks) => (
                <Link
                  href={ROUTES.signup}
                  className="font-medium text-ink underline decoration-hairline-2 decoration-1 underline-offset-4 transition-colors hover:decoration-ink"
                >
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </div>

        <div
          className="lg:col-span-6 fade-up"
          style={{ animationDelay: "180ms" }}
        >
          <HeroDevices
            diner={{ alt: t("hero.shotDiner"), role: t("hero.roleDiner") }}
            waiter={{ alt: t("hero.shotWaiter"), role: t("hero.roleWaiter") }}
            owner={{ alt: t("hero.shotOwner"), role: t("hero.roleOwner") }}
          />
        </div>
      </div>

      <div className="relative border-t border-hairline/80 bg-paper/70">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 lg:flex-row lg:items-center lg:gap-8 lg:px-8">
          <p className={`${eyebrow} shrink-0 text-muted`}>
            {t("hero.modulesLabel")}
          </p>
          <ul className="flex flex-wrap gap-2">
            {MODULES.map(({ key, Icon }) => (
              <li
                key={key}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-hairline bg-ivory px-3 text-[13px] text-ink-2"
              >
                <Icon size={15} className="text-terracotta-2" />
                {t(`hero.modules.${key}`)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

type Shot = { alt: string; role: string };

function HeroDevices({
  diner,
  waiter,
  owner,
}: {
  diner: Shot;
  waiter: Shot;
  owner: Shot;
}) {
  return (
    <div className="relative mx-auto w-full max-w-[440px] lg:max-w-[480px]">
      {/* Halo cálido detrás de los teléfonos. */}
      <div
        aria-hidden
        className="absolute left-1/2 top-[42%] h-[70%] w-[95%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(201,83,46,0.18),rgba(184,137,59,0.08)_55%,transparent)]"
      />

      {/* Los laterales giran desde su esquina superior externa: así no se
          salen del contenedor y su rótulo queda a la vista, del lado de afuera. */}
      <figure className="absolute left-0 top-[12%] w-[34%]">
        <div className="origin-top-left -rotate-[4deg]">
          <PhoneFrame
            size="sm"
            src="/landing/05b-mesero-mesas.webp"
            alt={waiter.alt}
            sizes="(min-width: 1024px) 164px, (min-width: 480px) 150px, 33vw"
          />
        </div>
        <Caption align="start">{waiter.role}</Caption>
      </figure>

      <figure className="absolute right-0 top-[12%] w-[34%]">
        <div className="origin-top-right rotate-[4deg]">
          <PhoneFrame
            size="sm"
            src="/landing/10-resumen.webp"
            alt={owner.alt}
            sizes="(min-width: 1024px) 164px, (min-width: 480px) 150px, 33vw"
          />
        </div>
        <Caption align="end">{owner.role}</Caption>
      </figure>

      <figure className="relative z-10 mx-auto w-[48%]">
        <PhoneFrame
          size="md"
          preload
          src="/landing/01-carta-comensal.webp"
          alt={diner.alt}
          sizes="(min-width: 1024px) 232px, (min-width: 480px) 212px, 46vw"
        />
        <Caption accent>{diner.role}</Caption>
      </figure>
    </div>
  );
}

function Caption({
  children,
  accent = false,
  align = "center",
}: {
  children: React.ReactNode;
  accent?: boolean;
  align?: "start" | "center" | "end";
}) {
  const justify =
    align === "start"
      ? "justify-start pl-1"
      : align === "end"
        ? "justify-end pr-1"
        : "justify-center";
  return (
    <figcaption
      className={`mt-5 flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted ${justify}`}
    >
      <span
        aria-hidden
        className={
          "h-1.5 w-1.5 rounded-full " +
          (accent ? "bg-terracotta" : "bg-hairline-2")
        }
      />
      {children}
    </figcaption>
  );
}
