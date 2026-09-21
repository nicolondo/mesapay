"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CONCEPTOS_1012, DOC_TYPES_MANUALES } from "@/lib/erp/exogena/normativa";

/**
 * Captura manual de la exógena (formatos 1010 y 1012): formularios de alta
 * y botón de borrado. Cada acción pega a la API y refresca la página
 * (server component) para que la tabla y el XML se recalculen.
 *
 * Los montos se escriben en PESOS y viajan en centavos (× 100).
 */

const inputCls = "w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm";
const labelCls = "block text-[11px] uppercase tracking-wider text-op-muted mb-1";

type ApiError = "invalid" | "invalid_doc" | "invalid_dv" | "generic";

async function postJson(url: string, body: unknown): Promise<ApiError | null> {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return null;
    const j = (await r.json().catch(() => null)) as { error?: string } | null;
    const e = j?.error;
    return e === "invalid" || e === "invalid_doc" || e === "invalid_dv" ? e : "generic";
  } catch {
    return "generic";
  }
}

function pesosToCents(v: FormDataEntryValue | null): number {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function useSubmit(url: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function submit(form: HTMLFormElement, body: unknown) {
    setBusy(true);
    setError(null);
    const err = await postJson(url, body);
    setBusy(false);
    if (err) {
      setError(err);
      return;
    }
    form.reset();
    router.refresh();
  }
  return { busy, error, submit };
}

function ErrorLine({ error }: { error: ApiError | null }) {
  const t = useTranslations("opExogena");
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {t(`err_${error}`)}
    </p>
  );
}

function DocTypeSelect({ name, label }: { name: string; label: string }) {
  const t = useTranslations("opExogena");
  return (
    <label className="min-w-0">
      <span className={labelCls}>{label}</span>
      <select name={name} className={inputCls} defaultValue="NIT">
        {DOC_TYPES_MANUALES.map((d) => (
          <option key={d} value={d}>
            {t(`docType_${d}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Alta de socio / accionista (1010). */
export function ShareholderForm({ year }: { year: number }) {
  const t = useTranslations("opExogena");
  const { busy, error, submit } = useSubmit("/api/operator/reports/exogena/shareholders");

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const dv = String(fd.get("dv") ?? "").trim();
    void submit(form, {
      year,
      name: String(fd.get("name") ?? "").trim(),
      docType: String(fd.get("docType") ?? "NIT"),
      docNumber: String(fd.get("docNumber") ?? "").trim(),
      ...(dv ? { dv } : {}),
      sharePctBps: Math.round(Number(fd.get("pct") ?? 0) * 100),
      nominalCents: pesosToCents(fd.get("nominal")),
      premiumCents: pesosToCents(fd.get("premium")) || 0,
    });
  }

  return (
    <form onSubmit={onSubmit} className="rounded-2xl border border-op-border bg-op-surface p-3 sm:p-4 space-y-3">
      <div className="text-sm font-medium">{t("shTitle")}</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="min-w-0 sm:col-span-2">
          <span className={labelCls}>{t("shName")}</span>
          <input name="name" required maxLength={200} className={inputCls} autoComplete="off" />
        </label>
        <DocTypeSelect name="docType" label={t("shDocType")} />
        <div className="grid grid-cols-[1fr_72px] gap-2">
          <label className="min-w-0">
            <span className={labelCls}>{t("shDocNumber")}</span>
            <input name="docNumber" required maxLength={30} className={inputCls} inputMode="numeric" autoComplete="off" />
          </label>
          <label className="min-w-0">
            <span className={labelCls}>{t("shDv")}</span>
            <input name="dv" maxLength={1} pattern="\d" className={inputCls} inputMode="numeric" />
          </label>
        </div>
        <label className="min-w-0">
          <span className={labelCls}>{t("shPct")}</span>
          <input name="pct" type="number" min={0} max={100} step="0.01" required className={inputCls} />
        </label>
        <label className="min-w-0">
          <span className={labelCls}>{t("shNominal")}</span>
          <input name="nominal" type="number" min={0} step="1" required className={inputCls} inputMode="numeric" />
        </label>
        <label className="min-w-0">
          <span className={labelCls}>{t("shPremium")}</span>
          <input name="premium" type="number" min={0} step="1" defaultValue={0} className={inputCls} inputMode="numeric" />
        </label>
        <div className="flex items-end">
          <button type="submit" disabled={busy} className="mp-btn mp-btn--primary mp-btn--sm w-full">
            {busy ? t("saving") : t("save")}
          </button>
        </div>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

/** Alta de cuenta / inversión (1012). */
export function HoldingForm({ year }: { year: number }) {
  const t = useTranslations("opExogena");
  const { busy, error, submit } = useSubmit("/api/operator/reports/exogena/holdings");

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    void submit(form, {
      year,
      concept: String(fd.get("concept") ?? "1110"),
      entityName: String(fd.get("entityName") ?? "").trim(),
      entityDocType: String(fd.get("entityDocType") ?? "NIT"),
      entityDocNumber: String(fd.get("entityDocNumber") ?? "").trim(),
      valueCents: pesosToCents(fd.get("value")),
    });
  }

  return (
    <form onSubmit={onSubmit} className="rounded-2xl border border-op-border bg-op-surface p-3 sm:p-4 space-y-3">
      <div className="text-sm font-medium">{t("hoTitle")}</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="min-w-0 sm:col-span-2">
          <span className={labelCls}>{t("hoConcept")}</span>
          <select name="concept" className={inputCls} defaultValue="1110">
            {CONCEPTOS_1012.map((c) => (
              <option key={c} value={c}>
                {t(`concept_${c}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 sm:col-span-2">
          <span className={labelCls}>{t("hoEntity")}</span>
          <input name="entityName" required maxLength={200} className={inputCls} autoComplete="off" />
        </label>
        <DocTypeSelect name="entityDocType" label={t("hoDocType")} />
        <label className="min-w-0">
          <span className={labelCls}>{t("hoDocNumber")}</span>
          <input name="entityDocNumber" required maxLength={30} className={inputCls} inputMode="numeric" autoComplete="off" />
        </label>
        <label className="min-w-0">
          <span className={labelCls}>{t("hoValue")}</span>
          <input name="value" type="number" min={0} step="1" required className={inputCls} inputMode="numeric" />
        </label>
        <div className="flex items-end">
          <button type="submit" disabled={busy} className="mp-btn mp-btn--primary mp-btn--sm w-full">
            {busy ? t("saving") : t("save")}
          </button>
        </div>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

/** Borra una fila manual (con confirmación) y refresca. */
export function DeleteRowButton({ kind, id }: { kind: "shareholders" | "holdings"; id: string }) {
  const t = useTranslations("opExogena");
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (!window.confirm(t("deleteConfirm"))) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/operator/reports/exogena/${kind}?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (r.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" onClick={onClick} disabled={busy} className="mp-btn mp-btn--danger mp-btn--sm">
      {t("delete")}
    </button>
  );
}
