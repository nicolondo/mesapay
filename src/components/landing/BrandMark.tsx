/** Monograma de la marca: la "M" en la tipografía display sobre tinta. */
export function BrandMark({ inverted = false }: { inverted?: boolean }) {
  return (
    <span
      aria-hidden
      className={
        "grid h-8 w-8 shrink-0 place-items-center rounded-[8px] font-display text-[21px] leading-none " +
        (inverted ? "bg-bone text-ink" : "bg-ink text-bone")
      }
    >
      {"M"}
    </span>
  );
}
