"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Tabs de sub-estación del bar (Cocteles / Bebidas / …). Enlazan RELATIVO al
 * path actual (`usePathname`) en vez de a `/operator/bar` fijo: así el usuario
 * con rol `bar` —que vive en `/bar`— se queda en `/bar?sub=…` (autorizado) en
 * vez de ser pateado a `/operator/bar` (que su rol no puede ver → "no pasa
 * nada"). El operador, en `/operator/bar`, se queda en `/operator/bar?sub=…`.
 */
export function BarSubTabs({
  subStations,
  activeSub,
  allLabel,
}: {
  subStations: string[];
  activeSub: string | null;
  allLabel: string;
}) {
  const pathname = usePathname();
  return (
    <div className="px-6 pt-4 pb-0 flex gap-2 overflow-x-auto scroll-hide">
      <Tab href={pathname} label={allLabel} active={!activeSub} />
      {subStations.map((s) => (
        <Tab
          key={s}
          href={`${pathname}?sub=${encodeURIComponent(s)}`}
          label={s}
          active={activeSub === s}
        />
      ))}
    </div>
  );
}

function Tab({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={
        "shrink-0 px-4 h-9 inline-flex items-center rounded-full text-sm font-medium border transition-colors " +
        (active
          ? "bg-ink text-bone border-ink"
          : "bg-op-surface text-op-text border-op-border hover:bg-op-bg")
      }
    >
      {label}
    </Link>
  );
}
