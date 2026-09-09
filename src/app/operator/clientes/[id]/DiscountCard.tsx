"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Activar / cambiar / apagar el descuento de este comensal EN ESTE
 * restaurante.
 *
 * El endpoint no recibe `restaurantId`: lo toma de la sesión. Un
 * restaurante no puede pactar (ni leer) el descuento de otro.
 */
export function DiscountCard({
  dinerId,
  initial,
}: {
  dinerId: string;
  initial: { percent: number; note: string | null } | null;
}) {
  const t = useTranslations("opCustomers");
  const router = useRouter();
  const [, startTx] = useTransition();

  const [percent, setPercent] = useState(String(initial?.percent ?? 10));
  const [note, setNote] = useState(initial?.note ?? "");
  const [busy, setBusy] = useState<null | "save" | "remove">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy("save");
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(
        `/api/operator/diners/${dinerId}/discount`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            percent: Number(percent),
            note: note.trim() || undefined,
          }),
        },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErr(
          j.error === "invalid_percent"
            ? t("errInvalidPercent")
            : t("errGeneric"),
        );
        return;
      }
      setMsg(t("discountSaved"));
      startTx(() => router.refresh());
    } catch {
      setErr(t("errGeneric"));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(
        `/api/operator/diners/${dinerId}/discount`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        setErr(t("errGeneric"));
        return;
      }
      setMsg(t("discountRemoved"));
      startTx(() => router.refresh());
    } catch {
      setErr(t("errGeneric"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-2xl border border-hairline bg-paper p-5">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1">
        {t("discountTitle")}
      </div>
      <p className="text-sm text-muted mb-4">{t("discountHelp")}</p>

      <form onSubmit={save} className="space-y-3">
        <label className="block">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            {t("discountPercent")}
          </span>
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            className="mt-1 w-28 h-10 px-3 rounded-lg border border-hairline bg-ivory focus:outline-none focus:border-terracotta"
          />
        </label>
        <label className="block">
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
            {t("discountNote")}
          </span>
          <input
            type="text"
            maxLength={120}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full h-10 px-3 rounded-lg border border-hairline bg-ivory focus:outline-none focus:border-terracotta"
          />
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy !== null}
            className="h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-60"
          >
            {busy === "save"
              ? t("saving")
              : initial
                ? t("discountUpdate")
                : t("discountActivate")}
          </button>
          {initial && (
            <button
              type="button"
              onClick={remove}
              disabled={busy !== null}
              className="h-10 px-4 rounded-full border border-danger/40 text-sm text-danger disabled:opacity-60"
            >
              {busy === "remove" ? t("saving") : t("discountDeactivate")}
            </button>
          )}
        </div>
      </form>

      {err && <div className="text-danger text-xs mt-3">{err}</div>}
      {msg && <div className="text-[#1E5339] text-xs mt-3">{msg}</div>}
    </div>
  );
}
