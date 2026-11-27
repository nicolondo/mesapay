"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { DeferredTerminalPrint, type PrintPhase } from "@/lib/print/deferredTerminalPrint";
import type { StaffPrintDoc } from "@/lib/print/staffPrint";
import type { PrintPreferenceState } from "./PrintDestinationPicker";

export function useDeferredTerminalPrint(doc: StaffPrintDoc | null, pref: PrintPreferenceState, visible = true) {
  const [phase, setPhase] = useState<PrintPhase>(null);
  const [schedule] = useState(() => new DeferredTerminalPrint(setPhase));
  const path = usePathname();
  const id = doc?.kind === "shift" ? doc.shiftId : doc?.orderId;
  const previousDestination = useRef(pref.destination);
  useLayoutEffect(() => {
    if (previousDestination.current !== pref.destination) {
      previousDestination.current = pref.destination;
      if (pref.destination === "caja" || (pref.destination === "device" && pref.role !== "terminal")) schedule.cancel();
    }
  }, [schedule, pref.destination, pref.role]);
  useLayoutEffect(() => () => schedule.cancel(), [schedule, id, doc?.kind, path, pref.scope, visible]);
  const active = phase !== null;
  useLayoutEffect(() => {
    if (!active) return;
    document.addEventListener("visibilitychange", schedule.refresh);
    window.addEventListener("focus", schedule.refresh);
    window.addEventListener("pagehide", schedule.cancel);
    return () => {
      document.removeEventListener("visibilitychange", schedule.refresh);
      window.removeEventListener("focus", schedule.refresh);
      window.removeEventListener("pagehide", schedule.cancel);
    };
  }, [schedule, active]);
  return { phase, schedule };
}

export function DeferredPrintNotice({ seconds, onCancel, onCaja, className }: {
  seconds: number; onCancel: () => void; onCaja: () => void; className?: string;
}) {
  const t = useTranslations("staffPrint");
  return (
    <span className={className}>
      <span role="timer">{t("terminalCountdown", { seconds })}</span>{" "}
      {t("keepPageOpen")}
      <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        <button type="button" className="min-h-9 underline" onClick={onCancel}>{t("cancelPrint")}</button>
        <button type="button" className="min-h-9 underline" onClick={onCaja}>{t("useCaja")}</button>
      </span>
    </span>
  );
}
