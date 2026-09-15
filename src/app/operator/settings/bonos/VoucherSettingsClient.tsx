"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { MoneyInput } from "@/components/MoneyInput";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";

export type VoucherSettingsValue = {
  mode: "prepaid" | "credit";
  defaultValueCents: number;
  defaultExpiryDays: number | null;
};

const inputCls =
  "h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";

/**
 * Editor de la configuración de bonos. Guarda contra
 * /api/operator/vouchers/settings (módulo `vouchers`). Mismo lenguaje
 * visual que SalesTaxConfigEditor (Configuración → Impuestos).
 */
export function VoucherSettingsClient({
  initial,
  currency,
}: {
  initial: VoucherSettingsValue;
  currency: string;
}) {
  const t = useTranslations("opVouchers");
  const locale = useLocale() as Locale;
  const [mode, setMode] = useState<"prepaid" | "credit">(initial.mode);
  const [value, setValue] = useState(
    initial.defaultValueCents > 0 ? String(Math.round(initial.defaultValueCents / 100)) : "",
  );
  const [days, setDays] = useState(initial.defaultExpiryDays ? String(initial.defaultExpiryDays) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const valueCents = Math.round(Number(value || "0") * 100);
  const daysNumber = days === "" ? null : Number(days);
  const valid =
    valueCents >= 0 &&
    (daysNumber === null || (Number.isInteger(daysNumber) && daysNumber >= 1 && daysNumber <= 3650));

  async function save() {
    if (!valid) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/operator/vouchers/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, defaultValueCents: valueCents, defaultExpiryDays: daysNumber }),
      });
      if (!r.ok) throw new Error("save_failed");
      setMsg({ kind: "ok", text: t("saved") });
    } catch {
      setMsg({ kind: "error", text: t("saveError") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
            {t("modeLabel")}
          </span>
          <select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as "prepaid" | "credit");
              setMsg(null);
            }}
            className={inputCls + " min-w-[220px]"}
          >
            <option value="prepaid">{t("modePrepaid")}</option>
            <option value="credit">{t("modeCredit")}</option>
          </select>
        </label>
        <label className="block">
          <span className="block font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
            {t("defaultValueLabel")}
          </span>
          <MoneyInput
            value={value}
            onChange={(raw) => {
              setValue(raw);
              setMsg(null);
            }}
            ariaLabel={t("defaultValueLabel")}
            className={inputCls + " w-40 tabular-nums"}
          />
        </label>
        <label className="block">
          <span className="block font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
            {t("defaultExpiryLabel")}
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={3650}
            value={days}
            onChange={(e) => {
              setDays(e.target.value.replace(/\D/g, "").slice(0, 4));
              setMsg(null);
            }}
            placeholder={t("defaultExpiryPlaceholder")}
            className={inputCls + " w-28 tabular-nums"}
          />
        </label>
      </div>
      <p className="text-xs text-op-muted">
        {valueCents > 0
          ? t("defaultValueHint", { amount: formatMoney(valueCents, { currency, locale }) })
          : t("defaultValueEmptyHint")}
        {" · "}
        {daysNumber ? t("defaultExpiryHint", { days: daysNumber }) : t("defaultExpiryNoneHint")}
      </p>
      <div className="flex items-center justify-end gap-3">
        {msg && (
          <span className={"text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")} role="status">
            {msg.text}
          </span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={busy || !valid}
          className="mp-btn mp-btn--primary mp-btn--sm"
        >
          {busy ? t("saving") : t("save")}
        </button>
      </div>
    </section>
  );
}
