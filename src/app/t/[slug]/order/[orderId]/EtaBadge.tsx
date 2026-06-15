"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

function useTickingNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function minutesUntil(etaAtISO: string, now: number): number {
  return Math.ceil((new Date(etaAtISO).getTime() - now) / 60_000);
}

// Tope de lo que mostramos al comensal. El modelo de cola serial de la
// cocina puede dar números absurdos cuando hay un backlog de rondas (test o
// real); por encima de esto mostramos "Más de N min" en vez de asustar con
// "~218 min". No cambia el cálculo, solo la presentación.
const MAX_ETA_MIN = 45;

export function EtaBadge({ etaAtISO }: { etaAtISO: string }) {
  const t = useTranslations("order");
  const now = useTickingNow();
  const diffMin = minutesUntil(etaAtISO, now);
  const label =
    diffMin <= 1
      ? t("etaAlmost")
      : diffMin <= 3
        ? t("etaFewMin")
        : diffMin > MAX_ETA_MIN
          ? t("etaMax", { min: MAX_ETA_MIN })
          : t("etaMin", { min: diffMin });

  return (
    <span className="px-2 h-6 inline-flex items-center rounded-full text-[11px] font-medium bg-terracotta/10 text-terracotta">
      {label}
    </span>
  );
}

export function OrderEta({ etaAtISO }: { etaAtISO: string }) {
  const t = useTranslations("order");
  const now = useTickingNow();
  const diffMin = minutesUntil(etaAtISO, now);
  const headline =
    diffMin <= 1
      ? t("etaHeadlineAlmost")
      : diffMin <= 3
        ? t("etaHeadlineFew")
        : diffMin > MAX_ETA_MIN
          ? t("etaHeadlineMax", { min: MAX_ETA_MIN })
          : t("etaHeadlineMin", { min: diffMin });
  const sub =
    diffMin <= 1 ? t("etaSubAlmost") : t("etaSubDefault");
  return (
    <div className="rounded-2xl border border-hairline bg-cream/60 p-4">
      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted">
        {t("etaEstimated")}
      </div>
      <div className="font-display text-2xl mt-0.5 tracking-[-0.01em]">{headline}</div>
      <div className="text-xs text-muted mt-1">{sub}</div>
    </div>
  );
}
