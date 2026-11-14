"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { SupportDocConfigView } from "@/lib/dian/supportDocument/config";

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
const labelCls = "block font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1";

const STATUS_TONE: Record<SupportDocConfigView["status"], string> = {
  pending: "bg-paper text-op-muted",
  testing: "bg-[#C98A2E]/15 text-[#7F5A1F]",
  enabled: "bg-ok/15 text-ok",
};

type Form = {
  enabled: boolean;
  environment: "habilitacion" | "produccion";
  softwareId: string;
  softwarePin: string;
  testSetId: string;
  resolutionNumber: string;
  prefix: string;
  from: string;
  to: string;
  validFrom: string;
  validTo: string;
  adjustmentPrefix: string;
};

function formOf(c: SupportDocConfigView): Form {
  return {
    enabled: c.enabled,
    environment: c.environment,
    softwareId: c.softwareId ?? "",
    softwarePin: "",
    testSetId: c.testSetId ?? "",
    resolutionNumber: c.resolutionNumber ?? "",
    prefix: c.prefix ?? "",
    from: c.from != null ? String(c.from) : "",
    to: c.to != null ? String(c.to) : "",
    validFrom: c.validFrom ?? "",
    validTo: c.validTo ?? "",
    adjustmentPrefix: c.adjustmentPrefix,
  };
}

/**
 * Documento soporte en adquisiciones a no obligados (Res. DIAN 000167 de
 * 2021): activarlo, el software que el comercio registró en el portal de la
 * DIAN para este documento, el TestSetId, el ambiente y la autorización de
 * numeración propia del documento soporte. Usa el certificado de arriba.
 */
export function SupportDocumentSettings() {
  const t = useTranslations("opSupportDoc");
  const [config, setConfig] = useState<SupportDocConfigView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/operator/dian/support-document", { cache: "no-store" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setHidden(true);
          return;
        }
        const data = (await res.json()) as { config: SupportDocConfigView };
        setConfig(data.config);
        setForm(formOf(data.config));
      })
      .catch(() => !cancelled && setHidden(true));
    return () => {
      cancelled = true;
    };
  }, []);

  if (hidden) return null;
  if (!config || !form) return <div className="text-sm text-op-muted">{t("loading")}</div>;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const num = (v: string) => (v.trim() ? Number(v.replace(/\D/g, "")) : null);

  async function save() {
    if (!form || !config) return;
    if (form.environment === "produccion" && config.environment !== "produccion" && !window.confirm(t("confirmProduction"))) {
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/operator/dian/support-document", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: form.enabled,
          environment: form.environment,
          softwareId: form.softwareId.trim() || null,
          ...(form.softwarePin.trim() ? { softwarePin: form.softwarePin.trim() } : {}),
          testSetId: form.testSetId.trim() || null,
          resolutionNumber: form.resolutionNumber.trim() || null,
          prefix: form.prefix.trim() || null,
          from: num(form.from),
          to: num(form.to),
          validFrom: form.validFrom || null,
          validTo: form.validTo || null,
          adjustmentPrefix: form.adjustmentPrefix.trim() || "NAS",
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { config?: SupportDocConfigView; error?: string; detail?: string[] };
      if (!res.ok || !data.config) {
        const fields = (data.detail ?? []).map((d) => (t.has(`settingsField.${d}`) ? t(`settingsField.${d}`) : d));
        setMsg({
          ok: false,
          text: fields.length ? t("settingsInvalid", { fields: fields.join(", ") }) : t.has(`errors.${data.error}`) ? t(`errors.${data.error}`) : t("errors.generic"),
        });
        return;
      }
      setConfig(data.config);
      setForm(formOf(data.config));
      setMsg({ ok: true, text: t("settingsSaved") });
    } catch {
      setMsg({ ok: false, text: t("errors.network") });
    } finally {
      setBusy(false);
    }
  }

  const missing = config.missing.filter((m) => m !== "enabled");

  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-4" id="documento-soporte">
      <div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">{t("settingsTitle")}</div>
          <span className={"px-3 h-6 inline-flex items-center rounded-full text-[11px] font-medium " + STATUS_TONE[config.status]}>
            {t(`status.${config.status}`)}
          </span>
        </div>
        <p className="text-xs text-op-muted mt-1">{t("settingsIntro")}</p>
        <Link href="/operator/ayuda/facturacion/documento-soporte" className="text-[11px] text-terracotta underline">
          {t("helpLink")}
        </Link>
      </div>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        <span>{t("enabledLabel")}</span>
      </label>

      <div className="space-y-3">
        <div className="text-sm font-medium">{t("softwareTitle")}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="sd-sw">{t("softwareIdLabel")}</label>
            <input id="sd-sw" className={inputCls} value={form.softwareId} onChange={(e) => set("softwareId", e.target.value)} />
          </div>
          <div>
            <label className={labelCls} htmlFor="sd-pin">{t("softwarePinLabel")}</label>
            <input
              id="sd-pin"
              type="password"
              autoComplete="off"
              className={inputCls}
              placeholder={config.hasSoftwarePin ? "••••" : ""}
              value={form.softwarePin}
              onChange={(e) => set("softwarePin", e.target.value)}
            />
            {config.hasSoftwarePin && <p className="text-[11px] text-op-muted mt-1">{t("pinUnchanged")}</p>}
          </div>
        </div>
        <p className="text-[11px] text-op-muted">{t("softwareIdHint")}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls} htmlFor="sd-env">{t("envLabel")}</label>
            <select
              id="sd-env"
              className={inputCls}
              value={form.environment}
              onChange={(e) => set("environment", e.target.value as Form["environment"])}
            >
              <option value="habilitacion">{t("envHabilitacion")}</option>
              <option value="produccion">{t("envProduccion")}</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="sd-test">{t("testSetLabel")}</label>
            <input id="sd-test" className={inputCls} value={form.testSetId} onChange={(e) => set("testSetId", e.target.value)} />
          </div>
        </div>
        <p className="text-[11px] text-op-muted">{t("envHint")}</p>
      </div>

      <div className="space-y-3">
        <div className="text-sm font-medium">{t("resolutionTitle")}</div>
        <p className="text-[11px] text-op-muted">{t("resolutionHelp")}</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className={labelCls} htmlFor="sd-res">{t("settingsField.resolutionNumber")}</label>
            <input
              id="sd-res"
              inputMode="numeric"
              className={inputCls}
              value={form.resolutionNumber}
              onChange={(e) => set("resolutionNumber", e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="sd-prefix">{t("settingsField.prefix")}</label>
            <input
              id="sd-prefix"
              maxLength={4}
              className={inputCls}
              value={form.prefix}
              onChange={(e) => set("prefix", e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="sd-from">{t("settingsField.from")}</label>
            <input id="sd-from" inputMode="numeric" className={inputCls} value={form.from} onChange={(e) => set("from", e.target.value.replace(/\D/g, ""))} />
          </div>
          <div>
            <label className={labelCls} htmlFor="sd-to">{t("settingsField.to")}</label>
            <input id="sd-to" inputMode="numeric" className={inputCls} value={form.to} onChange={(e) => set("to", e.target.value.replace(/\D/g, ""))} />
          </div>
          <div>
            <label className={labelCls} htmlFor="sd-vf">{t("settingsField.validFrom")}</label>
            <input id="sd-vf" type="date" className={inputCls} value={form.validFrom} onChange={(e) => set("validFrom", e.target.value)} />
          </div>
          <div>
            <label className={labelCls} htmlFor="sd-vt">{t("settingsField.validTo")}</label>
            <input id="sd-vt" type="date" className={inputCls} value={form.validTo} onChange={(e) => set("validTo", e.target.value)} />
          </div>
          <div>
            <label className={labelCls} htmlFor="sd-nas">{t("settingsField.adjustmentPrefix")}</label>
            <input
              id="sd-nas"
              maxLength={6}
              className={inputCls}
              value={form.adjustmentPrefix}
              onChange={(e) => set("adjustmentPrefix", e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase())}
            />
          </div>
        </div>
        <p className="text-[11px] text-op-muted">{t("adjustmentPrefixHint")}</p>
        {config.nextNumber != null && config.prefix && (
          <p className="text-xs text-op-muted">{t("nextNumber", { number: `${config.prefix}${config.nextNumber}` })}</p>
        )}
      </div>

      {form.enabled && missing.length > 0 && (
        <div className="rounded-xl border border-dashed border-op-border bg-op-bg p-3 text-xs text-op-muted">
          {t("configIncomplete", { fields: missing.map((m) => t(`configMissing.${m}`)).join(", ") })}
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {msg && <span className={"text-xs " + (msg.ok ? "text-ok" : "text-danger")}>{msg.text}</span>}
        <button type="button" className="mp-btn mp-btn--primary mp-btn--sm" onClick={save} disabled={busy}>
          {busy ? t("saving") : t("save")}
        </button>
      </div>
    </section>
  );
}
