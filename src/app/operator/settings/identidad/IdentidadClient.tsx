"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";

type Identidad = {
  // Nombre comercial — display público + sender de los correos
  // ("NOMBRE · MESAPAY <facturas@mesapay.co>"). Distinto de
  // legalName (razón social) que aparece dentro de la tirilla.
  name: string;
  logoUrl: string | null;
  legalName: string | null;
  taxId: string | null;
  legalAddress: string | null;
  legalCity: string | null;
  legalPhone: string | null;
  dianResolution: string | null;
  dianResolutionFrom: number | null;
  dianResolutionTo: number | null;
  dianResolutionDate: string | null; // YYYY-MM-DD
  invoicePrefix: string | null;
  // Próximo consecutivo a emitir. Default 1; el operador puede
  // ajustar si ya venía emitiendo en otra plataforma o quiere
  // arrancar desde dianResolutionFrom.
  invoiceNextNumber: number;
};

export function IdentidadClient({ initial }: { initial: Identidad }) {
  const t = useTranslations("opIdentity");
  const [v, setV] = useState<Identidad>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function set<K extends keyof Identidad>(key: K, value: Identidad[K]) {
    setV((prev) => ({ ...prev, [key]: value }));
    setMsg(null);
  }

  async function pickLogo(file: File) {
    setUploading(true);
    setMsg(null);
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/api/operator/uploads", { method: "POST", body: fd });
    setUploading(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setMsg({
        kind: "error",
        text: j.message ?? j.error ?? t("logoUploadError"),
      });
      return;
    }
    const j = (await r.json()) as { url: string };
    set("logoUrl", j.url);
    setMsg({ kind: "ok", text: t("logoUploaded") });
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/operator/settings/identidad", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(v),
    });
    setBusy(false);
    if (!r.ok) {
      setMsg({ kind: "error", text: t("saveError") });
      return;
    }
    setMsg({ kind: "ok", text: t("saved") });
  }

  return (
    <div className="space-y-6">
      {/* Logo */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-2">
          {t("logoSectionTitle")}
        </div>
        <p className="text-xs text-op-muted mb-3">{t("logoHelp")}</p>

        <div className="flex items-center gap-4">
          <div className="w-20 h-20 rounded-xl bg-paper border border-op-border flex items-center justify-center overflow-hidden shrink-0">
            {v.logoUrl ? (
              <img
                src={v.logoUrl}
                alt={t("logoAlt")}
                className="w-full h-full object-contain p-2"
              />
            ) : (
              <span className="text-[10px] text-op-muted">{t("logoEmpty")}</span>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/svg+xml,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickLogo(f);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="mp-btn mp-btn--primary mp-btn--sm"
            >
              {uploading
                ? t("logoUploading")
                : v.logoUrl
                  ? t("logoChange")
                  : t("logoUpload")}
            </button>
            {v.logoUrl && (
              <button
                type="button"
                onClick={() => set("logoUrl", null)}
                className="h-7 px-3 text-[11px] text-danger hover:underline self-start"
              >
                {t("logoRemove")}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Datos legales */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-3">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {t("legalSectionTitle")}
        </div>
        <Field label={t("fieldNameLabel")} hint={t("fieldNameHint")}>
          <input
            type="text"
            value={v.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={t("fieldNamePlaceholder")}
            maxLength={120}
            className={inputCls}
          />
        </Field>
        <Field label={t("fieldLegalNameLabel")}>
          <input
            type="text"
            value={v.legalName ?? ""}
            onChange={(e) => set("legalName", e.target.value || null)}
            placeholder={t("fieldLegalNamePlaceholder")}
            className={inputCls}
          />
        </Field>
        <Field label={t("fieldTaxIdLabel")} hint={t("fieldTaxIdHint")}>
          <input
            type="text"
            value={v.taxId ?? ""}
            onChange={(e) => set("taxId", e.target.value || null)}
            placeholder={t("fieldTaxIdPlaceholder")}
            className={inputCls}
          />
        </Field>
        <Field label={t("fieldAddressLabel")}>
          <input
            type="text"
            value={v.legalAddress ?? ""}
            onChange={(e) => set("legalAddress", e.target.value || null)}
            placeholder={t("fieldAddressPlaceholder")}
            className={inputCls}
          />
        </Field>
        <Field label={t("fieldCityLabel")}>
          <input
            type="text"
            value={v.legalCity ?? ""}
            onChange={(e) => set("legalCity", e.target.value || null)}
            placeholder={t("fieldCityPlaceholder")}
            className={inputCls}
          />
        </Field>
        <Field label={t("fieldPhoneLabel")}>
          <input
            type="text"
            value={v.legalPhone ?? ""}
            onChange={(e) => set("legalPhone", e.target.value || null)}
            placeholder={t("fieldPhonePlaceholder")}
            className={inputCls}
          />
        </Field>
      </section>

      {/* Resolución DIAN */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5 space-y-3">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {t("dianSectionTitle")}
        </div>
        <p className="text-xs text-op-muted">{t("dianHelp")}</p>
        <Field label={t("dianResolutionLabel")}>
          <input
            type="text"
            value={v.dianResolution ?? ""}
            onChange={(e) => set("dianResolution", e.target.value || null)}
            placeholder={t("dianResolutionPlaceholder")}
            className={inputCls}
          />
        </Field>
        <Field label={t("dianDateLabel")}>
          <input
            type="date"
            value={v.dianResolutionDate ?? ""}
            onChange={(e) =>
              set("dianResolutionDate", e.target.value || null)
            }
            className={inputCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("dianFromLabel")}>
            <input
              type="number"
              min={0}
              value={v.dianResolutionFrom ?? ""}
              onChange={(e) =>
                set(
                  "dianResolutionFrom",
                  e.target.value ? Number(e.target.value) : null,
                )
              }
              placeholder={t("dianFromPlaceholder")}
              className={inputCls}
            />
          </Field>
          <Field label={t("dianToLabel")}>
            <input
              type="number"
              min={0}
              value={v.dianResolutionTo ?? ""}
              onChange={(e) =>
                set(
                  "dianResolutionTo",
                  e.target.value ? Number(e.target.value) : null,
                )
              }
              placeholder={t("dianToPlaceholder")}
              className={inputCls}
            />
          </Field>
        </div>
        <Field label={t("prefixLabel")} hint={t("prefixHint")}>
          <input
            type="text"
            value={v.invoicePrefix ?? ""}
            onChange={(e) => set("invoicePrefix", e.target.value || null)}
            placeholder={t("prefixPlaceholder")}
            maxLength={10}
            className={inputCls + " uppercase"}
          />
        </Field>
        <Field
          label={t("nextNumberLabel")}
          hint={t("nextNumberHint")}
        >
          <input
            type="number"
            min={1}
            value={v.invoiceNextNumber}
            onChange={(e) =>
              set(
                "invoiceNextNumber",
                e.target.value ? Math.max(1, Number(e.target.value)) : 1,
              )
            }
            className={inputCls}
          />
          {/* Sugerencia: si está en 1 (default) y hay rango DIAN
              configurado, ofrecer arrancar desde el límite inferior
              del rango. */}
          {v.invoiceNextNumber === 1 &&
            v.dianResolutionFrom != null &&
            v.dianResolutionFrom > 1 && (
              <button
                type="button"
                onClick={() => set("invoiceNextNumber", v.dianResolutionFrom!)}
                className="mt-1 text-[10px] text-terracotta underline"
              >
                {t("startFrom", { n: v.dianResolutionFrom })}
              </button>
            )}
        </Field>
      </section>

      <div className="flex items-center justify-end gap-3">
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
          onClick={save}
          disabled={busy}
          className="mp-btn mp-btn--primary mp-btn--sm"
        >
          {busy ? t("saving") : t("save")}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
        {label}
      </div>
      {children}
      {hint && <div className="text-[10px] text-op-muted mt-1">{hint}</div>}
    </label>
  );
}

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
