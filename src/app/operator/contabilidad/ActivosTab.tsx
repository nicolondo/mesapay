"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatMoney } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import type { Locale } from "@/i18n/config";

type Asset = {
  id: string;
  name: string;
  purchaseDate: string;
  purchaseCents: number;
  salvageCents: number;
  usefulLifeMonths: number;
  assetAccountCode: string;
  active: boolean;
  monthlyCents: number;
  accumulatedCents: number;
};

// Cuentas PPE del alta — claves i18n por código.
const ASSET_ACCOUNT_KEYS: [string, string][] = [
  ["152005", "assetAcctKitchen"],
  ["152405", "assetAcctFurniture"],
  ["152805", "assetAcctComputers"],
  ["151605", "assetAcctImprovements"],
  ["154005", "assetAcctVehicles"],
];

/**
 * Activos fijos con depreciación en línea recta mensual. El asiento del mes
 * (516005 → 159205) lo genera el motor del Diario automáticamente.
 */
export function ActivosTab({ currency }: { currency: string }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const [name, setName] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [pricePesos, setPricePesos] = useState("");
  const [salvagePesos, setSalvagePesos] = useState("");
  const [lifeMonths, setLifeMonths] = useState("60");
  const [accountCode, setAccountCode] = useState("152005");

  async function load() {
    try {
      const r = await fetch("/api/operator/accounting/activos");
      if (!r.ok) throw new Error("load");
      const j = await r.json();
      setAssets(j.assets as Asset[]);
    } catch {
      setErr(true);
    }
  }
  useEffect(() => {
    let alive = true;
    fetch("/api/operator/accounting/activos")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (alive) setAssets(j.assets as Asset[]);
      })
      .catch(() => {
        if (alive) setErr(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const money = (c: number) => formatMoney(c, { currency, locale });

  async function create() {
    const purchaseCents = Number(pricePesos.replace(/\D/g, "")) * 100;
    const salvageCents = Number(salvagePesos.replace(/\D/g, "") || "0") * 100;
    const life = Number(lifeMonths);
    if (!name.trim() || !purchaseDate || !purchaseCents || !life) return;
    setBusy(true);
    const r = await fetch("/api/operator/accounting/activos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        purchaseDate,
        purchaseCents,
        salvageCents,
        usefulLifeMonths: life,
        assetAccountCode: accountCode,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      setErr(true);
      return;
    }
    setName("");
    setPurchaseDate("");
    setPricePesos("");
    setSalvagePesos("");
    setFormOpen(false);
    await load();
  }

  async function dispose(id: string, active: boolean) {
    if (active && !window.confirm(t("assetDisposeConfirm"))) return;
    setBusy(true);
    await fetch("/api/operator/accounting/activos", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assetId: id,
        action: active ? "dispose" : "reactivate",
      }),
    });
    setBusy(false);
    await load();
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-op-muted">{t("assetsIntro")}</p>

      {!formOpen ? (
        <button
          type="button"
          onClick={() => setFormOpen(true)}
          className="mp-btn mp-btn--primary mp-btn--block"
        >
          {t("assetNew")}
        </button>
      ) : (
        <div className="rounded-2xl border border-op-border bg-op-surface p-4 space-y-3">
          <label className="block">
            <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {t("assetName")}
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("assetNamePlaceholder")}
              className="mt-1 w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
                {t("assetPurchaseDate")}
              </span>
              <input
                type="date"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
                className="mt-1 w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm"
              />
            </label>
            <label className="block">
              <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
                {t("assetLifeMonths")}
              </span>
              <input
                inputMode="numeric"
                value={lifeMonths}
                onChange={(e) => setLifeMonths(e.target.value.replace(/\D/g, ""))}
                className="mt-1 w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm tabular"
              />
            </label>
            <label className="block">
              <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
                {t("assetPrice")}
              </span>
              <MoneyInput
                value={pricePesos}
                onChange={setPricePesos}
                ariaLabel={t("assetPrice")}
                placeholder="0"
                className="mt-1 w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm text-right"
              />
            </label>
            <label className="block">
              <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
                {t("assetSalvage")}
              </span>
              <MoneyInput
                value={salvagePesos}
                onChange={setSalvagePesos}
                ariaLabel={t("assetSalvage")}
                placeholder="0"
                className="mt-1 w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm text-right"
              />
            </label>
          </div>
          <label className="block">
            <span className="font-mono text-[10px] tracking-wider uppercase text-op-muted">
              {t("assetAccount")}
            </span>
            <select
              value={accountCode}
              onChange={(e) => setAccountCode(e.target.value)}
              className="mt-1 w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm"
            >
              {ASSET_ACCOUNT_KEYS.map(([code, key]) => (
                <option key={code} value={code}>
                  {`${code} · ${t(key)}`}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={create}
              disabled={busy}
              className="mp-btn mp-btn--primary flex-1"
            >
              {busy ? t("saving") : t("assetCreate")}
            </button>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="mp-btn mp-btn--ghost px-4"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {err ? (
        <div className="text-sm text-danger">{t("errLoadFailed")}</div>
      ) : assets === null ? (
        <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>
      ) : assets.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
          {t("assetsEmpty")}
        </div>
      ) : (
        <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
          {assets.map((a) => (
            <div
              key={a.id}
              className="px-4 py-2.5 border-b border-op-border last:border-b-0 flex items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <div
                  className={
                    "text-sm font-medium truncate" +
                    (a.active ? "" : " opacity-50 line-through")
                  }
                >
                  {a.name}
                </div>
                <div className="text-[11px] text-op-muted mt-0.5 truncate">
                  {[
                    a.assetAccountCode,
                    a.purchaseDate,
                    t("assetLifeShort", { months: a.usefulLifeMonths }),
                    t("assetMonthlyShort", { amount: money(a.monthlyCents) }),
                  ].join(" · ")}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-mono tabular text-sm">
                  {money(a.purchaseCents)}
                </div>
                <div className="text-[11px] text-op-muted tabular">
                  {t("assetAccumulated", { amount: money(a.accumulatedCents) })}
                </div>
              </div>
              <button
                type="button"
                onClick={() => dispose(a.id, a.active)}
                disabled={busy}
                className="mp-chip shrink-0"
              >
                {a.active ? t("assetDispose") : t("assetReactivate")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
