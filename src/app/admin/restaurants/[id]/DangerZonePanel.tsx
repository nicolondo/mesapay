"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Borrado selectivo de datos operativos de un comercio (platform-admin).
 * Útil para resetear un comercio que estuvo en prueba sin recrearlo.
 *
 * Defaults: vienen marcadas todas MENOS mesas, cartas y menú — lo más
 * común es limpiar el movimiento (órdenes/cobros/facturas/cierres/
 * reseñas) y conservar la configuración del comercio (su carta y mesas).
 *
 * Es IRREVERSIBLE: exige tipear el slug del comercio antes de ejecutar.
 */
type CatKey =
  | "orders"
  | "payments"
  | "invoices"
  | "shifts"
  | "reviews"
  | "erp"
  | "tables"
  | "menus"
  | "menu";

// Orden de listado + default marcado. Todo menos ERP/mesas/cartas/menú
// (ERP incluye el catálogo de insumos/proveedores → opt-in explícito).
const CATS: { key: CatKey; def: boolean }[] = [
  { key: "orders", def: true },
  { key: "payments", def: true },
  { key: "invoices", def: true },
  { key: "shifts", def: true },
  { key: "reviews", def: true },
  { key: "erp", def: false },
  { key: "tables", def: false },
  { key: "menus", def: false },
  { key: "menu", def: false },
];

export function DangerZonePanel({
  restaurantId,
  slug,
}: {
  restaurantId: string;
  slug: string;
}) {
  const t = useTranslations("opAdmin");
  const router = useRouter();
  const [sel, setSel] = useState<Record<CatKey, boolean>>(
    () =>
      Object.fromEntries(CATS.map((c) => [c.key, c.def])) as Record<
        CatKey,
        boolean
      >,
  );
  const [confirming, setConfirming] = useState(false);
  const [slugInput, setSlugInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  const anySelected = Object.values(sel).some(Boolean);

  function toggle(key: CatKey) {
    setSel((p) => ({ ...p, [key]: !p[key] }));
    setMsg(null);
  }

  function errorText(code: string | undefined): string {
    if (code === "orders_block") return t("resetBlocked");
    if (code === "confirm_mismatch") return t("resetSlugMismatch");
    if (code === "nothing_selected") return t("resetNothing");
    return t("resetFail");
  }

  async function run() {
    setBusy(true);
    setMsg(null);
    const res = await fetch(
      `/api/admin/restaurants/${restaurantId}/reset-data`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmSlug: slugInput.trim(), ...sel }),
      },
    );
    const j = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setMsg({ kind: "error", text: errorText(j?.error) });
      return;
    }
    const total = Object.values(
      (j?.counts ?? {}) as Record<string, number>,
    ).reduce((s, n) => s + n, 0);
    setMsg({ kind: "ok", text: t("resetOk", { count: total }) });
    setConfirming(false);
    setSlugInput("");
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-danger/40 bg-danger/5 p-5 mb-4">
      <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-danger">
        {t("resetTitle")}
      </div>
      <div className="text-sm mt-1 text-op-muted">{t("resetIntro")}</div>

      <ul className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {CATS.map((c) => (
          <li key={c.key}>
            <label className="flex items-center gap-2.5 rounded-xl border border-op-border bg-op-surface px-3 py-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={sel[c.key]}
                onChange={() => toggle(c.key)}
                className="h-4 w-4 accent-danger"
              />
              <span className="text-sm">{t(`resetOpt_${c.key}`)}</span>
            </label>
          </li>
        ))}
      </ul>

      <p className="text-[11px] text-op-muted mt-3">{t("resetOrdersNote")}</p>

      {!confirming ? (
        <div className="mt-4 flex items-center justify-between gap-3">
          {msg && (
            <span
              className={
                "text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")
              }
            >
              {msg.text}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setMsg(null);
              setConfirming(true);
            }}
            disabled={!anySelected}
            className="ml-auto mp-btn mp-btn--danger mp-btn--sm"
          >
            {t("resetButton")}
          </button>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-danger/40 bg-op-surface p-4 space-y-3">
          <div className="text-sm font-medium">{t("resetConfirmTitle")}</div>
          <p className="text-xs text-op-muted">
            {t("resetConfirmBody", { slug })}
          </p>
          <input
            type="text"
            value={slugInput}
            onChange={(e) => setSlugInput(e.target.value)}
            placeholder={slug}
            autoComplete="off"
            className="w-full px-3 h-10 rounded-lg border border-op-border bg-op-bg text-sm font-mono"
          />
          {msg && msg.kind === "error" && (
            <div className="text-xs text-danger">{msg.text}</div>
          )}
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                setSlugInput("");
                setMsg(null);
              }}
              disabled={busy}
              className="mp-btn mp-btn--secondary mp-btn--sm"
            >
              {t("resetCancel")}
            </button>
            <button
              type="button"
              onClick={run}
              disabled={busy || slugInput.trim() !== slug}
              className="mp-btn mp-btn--danger-solid mp-btn--sm"
            >
              {busy ? t("resetBusy") : t("resetConfirmCta")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
