"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Ver y editar el país del comercio desde el detalle del admin. El país
 * define la moneda de cobro (suscripción + pagos), así que mostramos la
 * moneda derivada al lado. Las opciones son los países habilitados en la
 * config de plataforma. Sirve además para asignar país a comercios viejos
 * creados antes de que fuera obligatorio.
 */
type CountryOpt = { code: string; name: string; currency: string };

export function RestaurantCountryEditor({
  restaurantId,
  initialCountry,
  initialCountryName,
  currency,
  options,
}: {
  restaurantId: string;
  initialCountry: string | null;
  initialCountryName: string | null;
  currency: string;
  options: CountryOpt[];
}) {
  const t = useTranslations("opAdmin");
  const router = useRouter();
  const [, startTx] = useTransition();
  const [editing, setEditing] = useState(false);
  const [code, setCode] = useState(initialCountry ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const current = options.find((o) => o.code === (initialCountry ?? ""));
  const displayName = initialCountryName || current?.name || initialCountry;

  async function save() {
    if (!code) {
      setErr(t("errCountryRequired"));
      return;
    }
    const opt = options.find((o) => o.code === code);
    setBusy(true);
    setErr(null);
    const res = await fetch(`/api/admin/restaurants/${restaurantId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ country: code, countryName: opt?.name ?? null }),
    });
    setBusy(false);
    if (!res.ok) {
      setErr(t("countrySaveFailed"));
      return;
    }
    setEditing(false);
    startTx(() => router.refresh());
  }

  if (editing) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={busy}
          className="h-9 rounded-lg border border-op-border bg-op-bg px-2 text-sm focus:outline-none focus:border-terracotta"
        >
          <option value="">{t("countryNone")}</option>
          {options.map((o) => (
            <option key={o.code} value={o.code}>
              {o.name} · {o.currency}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="h-9 px-3 rounded-lg bg-ink text-bone text-xs font-medium disabled:opacity-50"
        >
          {busy ? "…" : t("countrySave")}
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setCode(initialCountry ?? "");
            setErr(null);
          }}
          disabled={busy}
          className="h-9 px-3 rounded-lg border border-op-border text-xs"
        >
          {t("cancel")}
        </button>
        {err && <span className="text-danger text-xs">{err}</span>}
      </div>
    );
  }

  return (
    <div className="font-mono text-[11px] text-op-muted mt-1 flex items-center gap-2 flex-wrap">
      <span>
        {t("countryLabel")}: {displayName ?? t("countryNone")} · {currency}
      </span>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-[11px] text-op-muted hover:text-ink font-mono tracking-wider uppercase"
      >
        {t("renameTitle")}
      </button>
    </div>
  );
}
