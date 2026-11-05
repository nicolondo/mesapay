"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatDate } from "@/lib/format";
import type { Locale } from "@/i18n/config";

/**
 * Recuperación EN LOTE de las facturas electrónicas del comercio que la
 * DIAN no dejó aceptadas por una causa ya corregida (admin de plataforma).
 * Primero se revisa —un listado que no llama a la DIAN ni toca nada—; sólo
 * con «Procesar» se reenvía (mismo número) o se consulta por CUFE, una
 * factura a la vez, con tope por corrida. Ver
 * src/app/api/admin/restaurants/[id]/dian-recovery/route.ts.
 */
type Item = {
  documentId: string;
  number: string;
  createdAt: string;
  state: string;
  cause: "zero_value_line" | "already_at_dian" | "dian_notification" | "dian_transient" | "other";
  action: "resend" | "check_status" | "none";
  lastError: string | null;
};
type Result = { documentId: string; outcome: string; reason?: string | null };

/** Tope por corrida del API (MAX_BATCH). */
const PER_RUN = 25;

export function DianRecoveryPanel({ restaurantId }: { restaurantId: string }) {
  const t = useTranslations("adminDianRecovery");
  const locale = useLocale() as Locale;
  const [items, setItems] = useState<Item[] | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState<"review" | "process" | string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cufes, setCufes] = useState<Record<string, string>>({});
  const url = `/api/admin/restaurants/${restaurantId}/dian-recovery`;

  async function review() {
    setBusy("review");
    setMsg(null);
    try {
      const res = await fetch(url, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as { items?: Item[] } | null;
      if (!res.ok || !data?.items) throw new Error();
      setItems(data.items);
    } catch {
      setMsg({ ok: false, text: t("error") });
    } finally {
      setBusy(null);
    }
  }

  const actionable = (items ?? []).filter((i) => i.action !== "none");
  const runCount = Math.min(PER_RUN, actionable.length);

  async function process() {
    if (busy || runCount === 0 || !window.confirm(t("processConfirm", { count: runCount }))) return;
    setBusy("process");
    setMsg(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: false, limit: runCount }),
      });
      if (res.status === 429) {
        setMsg({ ok: false, text: t("rateLimited") });
        return;
      }
      const data = (await res.json().catch(() => null)) as
        | { results?: Result[]; remaining?: number }
        | null;
      if (!res.ok || !data?.results) throw new Error();
      setResults((prev) => ({
        ...prev,
        ...Object.fromEntries(data.results!.map((r) => [r.documentId, r])),
      }));
      setMsg({
        ok: true,
        text: t("processDone", {
          done: data.results.length,
          accepted: data.results.filter((r) => r.outcome === "accepted").length,
          remaining: data.remaining ?? 0,
        }),
      });
    } catch {
      setMsg({ ok: false, text: t("error") });
    } finally {
      setBusy(null);
    }
  }

  async function checkWithCufe(documentId: string) {
    const cufe = (cufes[documentId] ?? "").trim();
    if (busy || !/^[0-9a-fA-F]{96}$/.test(cufe)) return;
    setBusy(documentId);
    setMsg(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId, cufe }),
      });
      if (res.status === 429) {
        setMsg({ ok: false, text: t("rateLimited") });
        return;
      }
      const data = (await res.json().catch(() => null)) as { result?: Result } | null;
      if (!res.ok || !data?.result) throw new Error();
      setResults((prev) => ({ ...prev, [documentId]: data.result! }));
    } catch {
      setMsg({ ok: false, text: t("error") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5 mb-4">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">{t("title")}</div>
      <p className="text-sm mt-1">{t("intro")}</p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={review}
          disabled={!!busy}
          className="mp-btn mp-btn--secondary mp-btn--sm"
        >
          {busy === "review" ? t("reviewing") : t("review")}
        </button>
        {items && runCount > 0 && (
          <button
            type="button"
            onClick={process}
            disabled={!!busy}
            className="mp-btn mp-btn--primary mp-btn--sm"
          >
            {busy === "process" ? t("processing") : t("process", { count: runCount })}
          </button>
        )}
        {msg && (
          <span role="status" className={"text-xs " + (msg.ok ? "text-ok" : "text-danger")}>
            {msg.text}
          </span>
        )}
      </div>

      {items && items.length === 0 && <p className="mt-4 text-sm text-op-muted">{t("empty")}</p>}

      {items && items.length > 0 && (
        <>
          <p className="mt-4 text-sm">{t("summary", { count: items.length, actionable: actionable.length })}</p>
          <ul className="mt-2 divide-y divide-op-border">
            {items.map((i) => {
              const r = results[i.documentId];
              return (
                <li key={i.documentId} className="py-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="font-mono font-medium">{i.number}</span>
                    <span className="text-[12px] text-op-muted">
                      {formatDate(i.createdAt, { locale, dateStyle: "medium", timeStyle: "short" })}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
                    <span>
                      <span className="text-op-muted">{t("colCause")}: </span>
                      {t(`cause_${i.cause}`)}
                    </span>
                    <span>
                      <span className="text-op-muted">{t("colAction")}: </span>
                      {t(`action_${i.action}`)}
                    </span>
                    {r && (
                      <span className={r.outcome === "accepted" ? "text-ok" : "text-danger"}>
                        <span className="text-op-muted">{t("colResult")}: </span>
                        {t(`outcome_${r.outcome}`)}
                        {r.reason ? ` · ${r.reason}` : ""}
                      </span>
                    )}
                  </div>
                  {i.lastError && (
                    <div className="mt-1 font-mono text-[10px] text-op-muted break-all">{i.lastError}</div>
                  )}
                  {i.action === "check_status" && r?.outcome !== "accepted" && (
                    <div className="mt-2">
                      <label className="block text-[11px] text-op-muted" htmlFor={`cufe-${i.documentId}`}>
                        {t("cufeLabel")}
                      </label>
                      <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                        <input
                          id={`cufe-${i.documentId}`}
                          value={cufes[i.documentId] ?? ""}
                          onChange={(e) => setCufes((p) => ({ ...p, [i.documentId]: e.target.value }))}
                          placeholder={t("cufePlaceholder")}
                          className="min-w-0 flex-1 rounded-lg border border-op-border bg-op-bg px-2 py-1 font-mono text-[11px]"
                          spellCheck={false}
                          autoComplete="off"
                        />
                        <button
                          type="button"
                          onClick={() => checkWithCufe(i.documentId)}
                          disabled={!!busy || !/^[0-9a-fA-F]{96}$/.test((cufes[i.documentId] ?? "").trim())}
                          className="mp-btn mp-btn--secondary mp-btn--sm shrink-0"
                        >
                          {t("cufeCheck")}
                        </button>
                      </div>
                      <p className="mt-1 text-[11px] text-op-muted">{t("cufeHint")}</p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
