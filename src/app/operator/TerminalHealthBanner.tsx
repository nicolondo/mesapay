"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { fetchTerminalHealth } from "@/components/payments/useTerminalHealthCheck";
import { formatDate } from "@/lib/format";
import type { Locale } from "@/i18n/config";

export function TerminalHealthBanner({ slug }: { slug: string }) {
  const t = useTranslations("operator");
  const locale = useLocale() as Locale;
  const [health, setHealth] = useState<Awaited<ReturnType<typeof fetchTerminalHealth>>>();
  useEffect(() => {
    const request = new AbortController();
    let loading = false;
    async function refresh() {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const data = await fetchTerminalHealth(slug, request.signal);
        if (!request.signal.aborted) setHealth(data);
      } catch { /* Keep the last known state until a successful poll. */ }
      finally { loading = false; }
    }
    void refresh();
    const timer = window.setInterval(refresh, 20_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      request.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [slug]);
  if (!health?.warnings.length) return null;
  return (
    <aside role="status" className="print:hidden shrink-0 border-b border-amber-300 bg-amber-50 text-amber-950 px-4 md:px-6 py-2 text-sm">
      {health.warnings.map(w => (
        <p key={w.deviceIds[0]}>{t("terminalHealthWarning", {
          device: w.serial && w.serial !== w.label ? `${w.label} (${w.serial})` : w.label,
          time: formatDate(w.since, { locale, timeZone: health.timeZone, dateStyle: "short", hourCycle: "h23" }),
          count: w.count,
        })}</p>
      ))}
    </aside>
  );
}
