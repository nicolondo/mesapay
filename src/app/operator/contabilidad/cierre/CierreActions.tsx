"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Botones de acción de la página de cierre. Cada uno pega a la API que ya
 * existe (la misma que usan las pestañas Diario e Impuestos) y, si salió
 * bien, refresca la página server-side — el estado (candado, numeración,
 * asiento de cierre) siempre se lee del servidor, nunca se replica acá.
 */

type ActionError = "already_closed" | "nothing_closed" | "generic";

function usePeriodAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ActionError | null>(null);

  async function run(request: () => Promise<Response>) {
    setBusy(true);
    setError(null);
    try {
      const r = await request();
      if (!r.ok) {
        const j = (await r.json().catch(() => null)) as { error?: string } | null;
        setError(
          j?.error === "already_closed" || j?.error === "nothing_closed"
            ? j.error
            : "generic",
        );
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("generic");
    } finally {
      setBusy(false);
    }
  }

  return { busy: busy || pending, error, run };
}

function ErrorLine({ error }: { error: ActionError | null }) {
  const t = useTranslations("opCierre");
  if (!error) return null;
  const msg =
    error === "already_closed"
      ? t("errAlreadyClosed")
      : error === "nothing_closed"
        ? t("errNothingClosed")
        : t("errGeneric");
  return (
    <div role="alert" className="mt-1 text-xs text-danger">
      {msg}
    </div>
  );
}

/** «Cerrar mes» — numera los comprobantes hasta `month` y fija el candado. */
export function CloseMonthButton({
  month,
  monthLabel,
}: {
  /** YYYY-MM */
  month: string;
  /** Rótulo ya localizado («Marzo de 2026») para el confirm. */
  monthLabel: string;
}) {
  const t = useTranslations("opCierre");
  const { busy, error, run } = usePeriodAction();
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (!window.confirm(t("closeConfirm", { month: monthLabel }))) return;
          void run(() =>
            fetch("/api/operator/accounting/close", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "close", month }),
            }),
          );
        }}
        className="mp-btn mp-btn--primary mp-btn--sm px-3"
      >
        {busy ? t("closeBusy") : t("closeMonth")}
      </button>
      <ErrorLine error={error} />
    </div>
  );
}

/** «Reabrir último mes» — el candado retrocede un mes. */
export function ReopenMonthButton({ monthLabel }: { monthLabel: string }) {
  const t = useTranslations("opCierre");
  const { busy, error, run } = usePeriodAction();
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (!window.confirm(t("reopenConfirm", { month: monthLabel }))) return;
          void run(() =>
            fetch("/api/operator/accounting/close", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "reopen" }),
            }),
          );
        }}
        className="mp-btn mp-btn--ghost mp-btn--sm px-3"
      >
        {busy ? t("reopenBusy") : t("reopenLast", { month: monthLabel })}
      </button>
      <ErrorLine error={error} />
    </div>
  );
}

/** Genera (o regenera) el asiento de cierre del ejercicio. */
export function YearClosingButton({ year, exists }: { year: number; exists: boolean }) {
  const t = useTranslations("opCierre");
  const { busy, error, run } = usePeriodAction();
  return (
    <div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          const q = exists
            ? t("yearClosingConfirmRegen", { year })
            : t("yearClosingConfirmGen", { year });
          if (!window.confirm(q)) return;
          void run(() =>
            fetch(`/api/operator/accounting/fiscal?year=${year}`, { method: "POST" }),
          );
        }}
        className={"mp-btn mp-btn--sm px-4 " + (exists ? "mp-btn--ghost" : "mp-btn--secondary")}
      >
        {busy ? t("yearClosingBusy") : exists ? t("yearClosingRegen") : t("yearClosingGen")}
      </button>
      <ErrorLine error={error} />
    </div>
  );
}
