"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

interface CountryRow {
  code: string;
  name: string;
  enabled: boolean;
  currency: string;
  cityCount: number;
  datasetSize: number;
}

const CURRENCY_OPTIONS = ["COP", "MXN"] as const;

export function CrmCountriesCard({
  initialCountries,
}: {
  initialCountries: CountryRow[];
}) {
  const t = useTranslations("opAdminCrm");
  const router = useRouter();
  const [countries, setCountries] = useState<CountryRow[]>(initialCountries);
  const [busy, setBusy] = useState<string | null>(null); // code of country being toggled
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function save(
    code: string,
    next: { enabled?: boolean; currency?: string },
  ) {
    const row = countries.find((c) => c.code === code);
    if (!row) return;
    const enabled = next.enabled ?? row.enabled;
    const currency = next.currency ?? row.currency;
    setBusy(code);
    setErr(null);
    setInfo(null);
    const res = await fetch("/api/admin/crm/countries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, enabled, currency }),
    });
    setBusy(null);
    if (!res.ok) {
      setErr(t("errorSave"));
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (next.enabled && !row.enabled && data.seeded > 0) {
      setInfo(t("seededInfo", { count: data.seeded }));
    }
    // Optimistic update + refresh.
    setCountries((prev) =>
      prev.map((c) => (c.code === code ? { ...c, enabled, currency } : c)),
    );
    startTransition(() => router.refresh());
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted mb-2">
        {t("cardTitle")}
      </div>
      <p className="text-xs text-op-muted mb-4">{t("cardIntro")}</p>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-op-muted border-b border-op-border">
            <th className="pb-2 font-normal">{t("colCountry")}</th>
            <th className="pb-2 font-normal">{t("colCurrency")}</th>
            <th className="pb-2 font-normal">{t("colCities")}</th>
            <th className="pb-2 font-normal">{t("colStatus")}</th>
            <th className="pb-2 font-normal" />
          </tr>
        </thead>
        <tbody>
          {countries.map((c) => (
            <tr key={c.code} className="border-b border-op-border/50 last:border-0">
              <td className="py-3 font-medium">
                {c.code} — {c.name}
              </td>
              <td className="py-3">
                <select
                  value={c.currency}
                  onChange={(e) => save(c.code, { currency: e.target.value })}
                  disabled={busy === c.code}
                  className="h-8 rounded-lg border border-op-border bg-op-bg px-2 text-xs focus:outline-none focus:border-terracotta disabled:opacity-40"
                >
                  {CURRENCY_OPTIONS.map((cur) => (
                    <option key={cur} value={cur}>
                      {cur}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-3 text-op-muted">
                {c.cityCount > 0
                  ? t("citiesCount", { count: c.cityCount })
                  : `${c.datasetSize} disponibles`}
              </td>
              <td className="py-3">
                <span
                  className={
                    "text-[10px] font-mono tracking-wider uppercase px-2 py-1 rounded border " +
                    (c.enabled
                      ? "bg-[#22C55E]/15 text-[#166534] border-[#22C55E]/40"
                      : "bg-op-bg text-op-muted border-op-border")
                  }
                >
                  {c.enabled ? t("enabled") : t("disabled")}
                </span>
              </td>
              <td className="py-3 text-right">
                <button
                  type="button"
                  onClick={() => save(c.code, { enabled: !c.enabled })}
                  disabled={busy === c.code}
                  className="h-8 px-3 rounded-full text-xs font-medium border border-op-border hover:border-ink/40 disabled:opacity-40"
                >
                  {busy === c.code
                    ? t("saving")
                    : c.enabled
                      ? t("disable")
                      : t("enable")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {err && <div className="mt-3 text-xs text-danger">{err}</div>}
      {info && <div className="mt-3 text-xs text-[#166534]">{info}</div>}
    </div>
  );
}
