"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { SalesTaxKind } from "@/lib/salesTax";

export type SalesTaxValue = { kind: SalesTaxKind; pct: number };

const inputCls =
  "h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";

/**
 * Editor del impuesto de ventas del comercio (tipo + tarifa). Es el ÚNICO
 * editor: vive en Configuración → Impuestos y en ningún otro lado. No lo
 * dupliques en otra pantalla — la resolución de numeración estuvo editable
 * en dos lados y dejó a un comercio con un número en una pantalla y otro
 * distinto en el XML que salió a la DIAN.
 *
 * Guarda contra /api/operator/settings/impuestos, que no pide ningún
 * módulo: el impuesto lo necesita todo comercio que facture, tenga o no
 * contabilidad.
 */
export function SalesTaxConfigEditor({
  initial,
  onSaved,
}: {
  initial: SalesTaxValue;
  /** Se llama con lo que quedó guardado en el server. */
  onSaved?: (saved: SalesTaxValue) => void;
}) {
  const t = useTranslations("opSalesTax");
  const tErp = useTranslations("opErp");
  const [kind, setKind] = useState<SalesTaxKind>(initial.kind);
  const [pct, setPct] = useState(initial.pct ? String(initial.pct) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  function changeKind(k: SalesTaxKind) {
    setKind(k);
    setMsg(null);
    // Tarifa típica al elegir el tipo, editable: INC 8% (restaurantes en
    // Colombia), IVA 19% (tarifa general).
    if (k === "inc" && !pct) setPct("8");
    if (k === "iva" && !pct) setPct("19");
  }

  const pctNumber = kind === "none" ? 0 : Number(pct);
  const pctValid =
    kind === "none" || (pct !== "" && pctNumber >= 0 && pctNumber <= 100);

  async function save() {
    if (!pctValid) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/operator/settings/impuestos", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ salesTaxKind: kind, salesTaxPct: pctNumber }),
      });
      if (!r.ok) throw new Error("save_failed");
      const j = (await r.json()) as {
        settings: { salesTaxKind: SalesTaxKind; salesTaxPct: number };
      };
      setMsg({ kind: "ok", text: t("saved") });
      onSaved?.({ kind: j.settings.salesTaxKind, pct: j.settings.salesTaxPct });
    } catch {
      setMsg({ kind: "error", text: tErp("errSaveFailed") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
            {tErp("taxConfigKind")}
          </span>
          <select
            value={kind}
            onChange={(e) => changeKind(e.target.value as SalesTaxKind)}
            className={inputCls + " min-w-[220px]"}
          >
            <option value="none">{tErp("taxConfigNone")}</option>
            <option value="inc">{tErp("taxKindInc")}</option>
            <option value="iva">{tErp("taxKindIva")}</option>
          </select>
        </label>
        {kind !== "none" && (
          <label className="block">
            <span className="block font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
              {tErp("taxConfigPct")}
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              value={pct}
              onChange={(e) => {
                setPct(e.target.value.replace(/\D/g, "").slice(0, 3));
                setMsg(null);
              }}
              className={inputCls + " w-24 tabular-nums"}
            />
          </label>
        )}
      </div>
      {kind !== "none" && (
        <p className="text-xs text-op-muted">{t("rateHint")}</p>
      )}
      <div className="flex items-center justify-end gap-3">
        {msg && (
          <span
            className={
              "text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")
            }
            role="status"
          >
            {msg.text}
          </span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={busy || !pctValid}
          className="mp-btn mp-btn--primary mp-btn--sm"
        >
          {busy ? tErp("taxConfigSaving") : tErp("taxConfigSave")}
        </button>
      </div>
    </section>
  );
}
