import Image from "next/image";

/**
 * Marcos de dispositivo para las capturas reales del producto (restaurante
 * de demostración con datos ficticios). Las capturas de celular son
 * 780×1688 y la de la tablet de cocina 1600×1112; el marco respeta esa
 * proporción para que `next/image` no recorte nada inesperado.
 *
 * `sizes` lo decide quien usa el marco (depende del layout): así el
 * navegador baja la variante justa en cada ancho de pantalla.
 */

const PHONE_W = 780;
const PHONE_H = 1688;
const TABLET_W = 1600;
const TABLET_H = 1112;

type ShotProps = {
  src: string;
  alt: string;
  sizes: string;
  /** Sólo para la captura principal del hero (LCP). */
  preload?: boolean;
  className?: string;
};

/** Bisel según el ancho con el que se muestra el teléfono. */
const PHONE_SIZE = {
  sm: { frame: "rounded-[1.65rem] p-[5px]", screen: "rounded-[1.35rem]" },
  md: { frame: "rounded-[2.1rem] p-[6px]", screen: "rounded-[1.75rem]" },
  lg: { frame: "rounded-[2.6rem] p-[8px]", screen: "rounded-[2.15rem]" },
} as const;

export function PhoneFrame({
  src,
  alt,
  sizes,
  preload,
  className = "",
  size = "md",
  tone = "light",
}: ShotProps & { size?: keyof typeof PHONE_SIZE; tone?: "light" | "dark" }) {
  const s = PHONE_SIZE[size];
  return (
    <div
      className={
        `relative bg-ink ${s.frame} ` +
        (tone === "dark"
          ? "ring-1 ring-bone/15 shadow-[0_30px_70px_-20px_rgba(0,0,0,0.7)] "
          : "ring-1 ring-ink/10 shadow-[0_34px_60px_-24px_rgba(26,22,19,0.45),0_14px_28px_-16px_rgba(26,22,19,0.3)] ") +
        className
      }
    >
      <div
        className={`relative overflow-hidden bg-paper ${s.screen}`}
        style={{ aspectRatio: `${PHONE_W} / ${PHONE_H}` }}
      >
        <Image
          src={src}
          alt={alt}
          width={PHONE_W}
          height={PHONE_H}
          sizes={sizes}
          preload={preload}
          className="block h-full w-full object-cover object-top"
        />
      </div>
    </div>
  );
}

export function TabletFrame({ src, alt, sizes, className = "" }: ShotProps) {
  return (
    <div
      className={
        "relative rounded-[1.4rem] bg-ink p-[8px] ring-1 ring-ink/10 shadow-[0_40px_80px_-30px_rgba(26,22,19,0.5),0_16px_32px_-18px_rgba(26,22,19,0.3)] sm:rounded-[2rem] sm:p-[13px] " +
        className
      }
    >
      <div
        className="relative overflow-hidden rounded-[0.9rem] bg-paper sm:rounded-[1.2rem]"
        style={{ aspectRatio: `${TABLET_W} / ${TABLET_H}` }}
      >
        <Image
          src={src}
          alt={alt}
          width={TABLET_W}
          height={TABLET_H}
          sizes={sizes}
          className="block h-full w-full object-cover object-top"
        />
      </div>
    </div>
  );
}
