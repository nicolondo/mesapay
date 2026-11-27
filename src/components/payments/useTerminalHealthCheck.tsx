"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AppDialog } from "@/components/ui/AppDialog";
import { formatDate } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import type { TerminalHealthWarning } from "@/lib/payments/terminalHealth";

export async function fetchTerminalHealth(slug: string, signal: AbortSignal): Promise<{ warnings: TerminalHealthWarning[]; timeZone: string }> {
  const response = await fetch(`/api/tenant/${encodeURIComponent(slug)}/terminal-health`, { cache: "no-store", signal });
  if (!response.ok) throw new Error("terminal_health_unavailable");
  return response.json();
}

// The caller keeps its checkout controls locked until the operator decides.
// Unmounting either while loading or while deciding cancels the original action.
export function useTerminalHealthCheck() {
  const t = useTranslations("pay");
  const locale = useLocale() as Locale;
  const [prompt, setPrompt] = useState<{ time?: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  const decision = useRef<((proceed: boolean) => void) | null>(null);
  useEffect(() => () => {
    active.current?.abort();
    active.current = null;
    decision.current?.(false);
  }, []);

  async function confirmDevice(slug: string, deviceId: string) {
    if (active.current) return false;
    const request = new AbortController();
    active.current = request;
    const timeout = window.setTimeout(() => request.abort(), 4000);
    let message: { time?: string };
    try {
      const { warnings, timeZone } = await fetchTerminalHealth(slug, request.signal);
      if (active.current !== request) return false;
      const warning = warnings.find(w => w.deviceIds.includes(deviceId));
      if (!warning) { active.current = null; return true; }
      message = { time: formatDate(warning.since, { locale, timeZone, dateStyle: undefined, hourCycle: "h23" }) };
    } catch {
      if (active.current !== request) return false;
      message = {};
    } finally { window.clearTimeout(timeout); }
    setPrompt(message);
    return new Promise<boolean>(resolve => { decision.current = resolve; });
  }

  function finish(proceed: boolean) {
    decision.current?.(proceed);
    decision.current = null;
    active.current = null;
    setPrompt(null);
  }

  const dialog = prompt && (
    <AppDialog label={t("healthTitle")} placement="center" onClose={() => finish(false)}
      className="bg-bone text-ink rounded-xl border border-hairline shadow-xl">
      <div className="p-5">
        <h2 className="font-semibold text-lg">{t("healthTitle")}</h2>
        <p className="mt-2 text-sm leading-relaxed">{prompt.time ? t("healthWarning", { time: prompt.time }) : t("healthUnknown")}</p>
        <div className="mt-5 flex flex-col gap-2">
          <button type="button" className="bg-ink text-bone rounded-lg px-4 py-3 font-semibold" onClick={() => finish(false)}>{t("healthOther")}</button>
          <button type="button" className="border border-hairline rounded-lg px-4 py-3" onClick={() => finish(true)}>{t("healthOverride")}</button>
        </div>
      </div>
    </AppDialog>
  );
  return { confirmDevice, dialog };
}
