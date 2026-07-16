"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";

// ── Tipos que espeja el contrato de /api/operator/dian ──────────────────

type DianStatus = {
  exists: boolean;
  environment: "habilitacion" | "produccion";
  status: "pending" | "testing" | "enabled";
  hasCertificate: boolean;
  certSubject: string | null;
  certNotAfter: string | null;
  certDaysToExpiry: number | null;
  hasSoftwareId: boolean;
  hasSoftwarePin: boolean;
  hasTechnicalKey: boolean;
  softwareId: string | null;
  testSetId: string | null;
  missingEmisor: string[];
};

type Emisor = {
  kind: "legalEntity" | "restaurant";
  legalName: string | null;
  taxId: string | null;
  resolution: string | null;
  invoicePrefix: string | null;
} | null;

type DianView = {
  status: DianStatus;
  emisor: Emisor;
  masterKeyReady: boolean;
};

type TestResult = {
  state: "accepted" | "pending" | "rejected" | "error";
  cufe: string | null;
  trackId: string | null;
  errors: string[];
  statusMessage: string | null;
};

export function DianConfigClient() {
  const t = useTranslations("opDian");
  const locale = useLocale() as Locale;

  const [view, setView] = useState<DianView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    setLoadError(null);
    const r = await fetch("/api/operator/dian", { cache: "no-store" });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setLoadError(mapError(t, j.error));
      return;
    }
    setView((await r.json()) as DianView);
  }

  // GET inicial al montar. La escritura de estado ocurre dentro del callback
  // async (no en el cuerpo del effect) — patrón establecido en el ERP.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await fetch("/api/operator/dian", { cache: "no-store" });
      if (cancelled) return;
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setLoadError(mapError(t, j.error));
        return;
      }
      setView((await r.json()) as DianView);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loadError) {
    return <Banner tone="error">{loadError}</Banner>;
  }
  if (!view) {
    return <div className="text-sm text-op-muted">{t("loading")}</div>;
  }

  const { status, emisor, masterKeyReady } = view;
  const canSave = masterKeyReady;

  return (
    <div className="space-y-5">
      {/* Aviso: el server no puede cifrar secretos todavía. */}
      {!masterKeyReady && <Banner tone="error">{t("masterKeyNotReady")}</Banner>}

      {/* Estado general */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-2">
          {t("statusKicker")}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <StatusBadge status={status.status} t={t} />
          <span className="px-3 h-6 inline-flex items-center rounded-full text-[11px] font-medium bg-paper text-op-muted">
            {status.environment === "produccion"
              ? t("envProduccion")
              : t("envHabilitacion")}
          </span>
        </div>
      </section>

      {/* Emisor (solo lectura) */}
      <EmisorSection t={t} emisor={emisor} missing={status.missingEmisor} />

      {/* Paso 1 — Certificado */}
      <CertificateSection
        t={t}
        locale={locale}
        status={status}
        canSave={canSave}
        onSaved={load}
      />

      {/* Paso 2 — Credenciales */}
      <CredentialsSection
        t={t}
        status={status}
        canSave={canSave}
        onSaved={load}
      />

      {/* Paso 3 — Habilitación */}
      <HabilitacionSection t={t} status={status} canSave={canSave} onDone={load} />
    </div>
  );
}

// ── Emisor ──────────────────────────────────────────────────────────────

const EMISOR_LABEL_KEY: Record<string, string> = {
  legalName: "emisorLegalName",
  taxId: "emisorTaxId",
  resolution: "emisorResolution",
  invoicePrefix: "emisorPrefix",
};

function EmisorSection({
  t,
  emisor,
  missing,
}: {
  t: ReturnType<typeof useTranslations>;
  emisor: Emisor;
  missing: string[];
}) {
  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-3">
        {t("emisorKicker")}
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
        <ReadonlyField label={t("emisorLegalName")} value={emisor?.legalName} t={t} />
        <ReadonlyField label={t("emisorTaxId")} value={emisor?.taxId} t={t} />
        <ReadonlyField label={t("emisorResolution")} value={emisor?.resolution} t={t} />
        <ReadonlyField label={t("emisorPrefix")} value={emisor?.invoicePrefix} t={t} />
      </dl>
      {missing.length > 0 && (
        <div className="mt-4">
          <Banner tone="warning">
            {t("emisorMissing", {
              fields: missing
                .map((m) => (EMISOR_LABEL_KEY[m] ? t(EMISOR_LABEL_KEY[m]) : m))
                .join(", "),
            })}
          </Banner>
          <p className="text-[11px] text-op-muted mt-2">{t("emisorMissingHint")}</p>
        </div>
      )}
    </section>
  );
}

function ReadonlyField({
  label,
  value,
  t,
}: {
  label: string;
  value: string | null | undefined;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div>
      <dt className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-0.5">
        {label}
      </dt>
      <dd className={"text-sm " + (value ? "" : "text-op-muted italic")}>
        {value || t("emisorEmpty")}
      </dd>
    </div>
  );
}

// ── Paso 1 · Certificado ────────────────────────────────────────────────

function CertificateSection({
  t,
  locale,
  status,
  canSave,
  onSaved,
}: {
  t: ReturnType<typeof useTranslations>;
  locale: Locale;
  status: DianStatus;
  canSave: boolean;
  onSaved: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const expiringSoon =
    status.certDaysToExpiry != null && status.certDaysToExpiry <= 30;

  async function submit() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setMsg(t("certPickFile"));
      return;
    }
    if (!password) {
      setMsg(t("certNeedPassword"));
      return;
    }
    setBusy(true);
    setMsg(null);
    const fd = new FormData();
    fd.append("file", file);
    fd.append("password", password);
    const r = await fetch("/api/operator/dian/certificate", {
      method: "POST",
      body: fd,
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setMsg(mapError(t, j.error));
      return;
    }
    setPassword("");
    setOpen(false);
    await onSaved();
  }

  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-5">
      <StepHeader index={1} title={t("certTitle")} t={t} />
      <p className="text-xs text-op-muted mt-1 mb-3">{t("certHelp")}</p>

      {status.hasCertificate ? (
        <div className="rounded-xl border border-op-border bg-op-bg p-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-3 h-6 inline-flex items-center rounded-full text-[11px] font-medium bg-ok/15 text-ok">
              {t("certRegistered")}
            </span>
            {expiringSoon && (
              <span className="px-3 h-6 inline-flex items-center rounded-full text-[11px] font-medium bg-danger/15 text-danger">
                {t("certExpiringSoon")}
              </span>
            )}
          </div>
          {status.certSubject && (
            <div className="text-sm mt-2 break-words">{status.certSubject}</div>
          )}
          {status.certNotAfter && (
            <div
              className={
                "text-xs mt-1 " + (expiringSoon ? "text-danger" : "text-op-muted")
              }
            >
              {t("certExpiresOn", {
                date: formatDate(status.certNotAfter, {
                  locale,
                  dateStyle: "medium",
                }),
              })}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-op-border bg-op-bg p-4 text-sm text-op-muted">
          {t("certNotLoaded")}
        </div>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={() => {
            setMsg(null);
            setOpen((v) => !v);
          }}
          disabled={!canSave}
          className="mp-btn mp-btn--primary mp-btn--sm"
        >
          {status.hasCertificate ? t("certReplace") : t("certUpload")}
        </button>
      </div>

      {open && (
        <div className="mt-4 rounded-xl border border-op-border bg-op-bg p-4 space-y-3">
          <FieldLabel label={t("certFileLabel")} hint={t("certFileHint")}>
            <input
              ref={fileRef}
              type="file"
              accept=".p12,.pfx"
              className="block w-full text-sm file:mr-3 file:h-9 file:px-3 file:rounded-lg file:border-0 file:bg-ink file:text-bone file:text-xs file:font-medium"
            />
          </FieldLabel>
          <FieldLabel label={t("certPasswordLabel")}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              className={inputCls}
            />
          </FieldLabel>
          {msg && <p className="text-xs text-danger">{msg}</p>}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setMsg(null);
              }}
              className="mp-btn mp-btn--ghost mp-btn--sm"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !canSave}
              className="mp-btn mp-btn--primary mp-btn--sm"
            >
              {busy ? t("certUploading") : t("save")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ── Paso 2 · Credenciales ───────────────────────────────────────────────

function CredentialsSection({
  t,
  status,
  canSave,
  onSaved,
}: {
  t: ReturnType<typeof useTranslations>;
  status: DianStatus;
  canSave: boolean;
  onSaved: () => Promise<void>;
}) {
  const [softwareId, setSoftwareId] = useState(status.softwareId ?? "");
  const [softwarePin, setSoftwarePin] = useState("");
  const [technicalKey, setTechnicalKey] = useState("");
  const [testSetId, setTestSetId] = useState(status.testSetId ?? "");
  const [environment, setEnvironment] = useState<"habilitacion" | "produccion">(
    status.environment,
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  async function save() {
    setBusy(true);
    setMsg(null);
    // Solo mandamos campos con valor: los secretos vacíos = "no cambiar".
    const body: Record<string, string> = { environment };
    if (softwareId.trim()) body.softwareId = softwareId.trim();
    if (softwarePin.trim()) body.softwarePin = softwarePin.trim();
    if (technicalKey.trim()) body.technicalKey = technicalKey.trim();
    if (testSetId.trim()) body.testSetId = testSetId.trim();

    const r = await fetch("/api/operator/dian", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setMsg({ kind: "error", text: mapError(t, j.error) });
      return;
    }
    setSoftwarePin("");
    setTechnicalKey("");
    setMsg({ kind: "ok", text: t("credsSaved") });
    await onSaved();
  }

  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-5">
      <StepHeader index={2} title={t("credsTitle")} t={t} />
      <p className="text-xs text-op-muted mt-1 mb-3">{t("credsHelp")}</p>

      <div className="space-y-3">
        <FieldLabel label={t("credsSoftwareIdLabel")} hint={t("credsSoftwareIdHint")}>
          <input
            type="text"
            value={softwareId}
            onChange={(e) => setSoftwareId(e.target.value)}
            className={inputCls}
          />
        </FieldLabel>
        <FieldLabel
          label={t("credsSoftwarePinLabel")}
          hint={status.hasSoftwarePin ? t("credsUnchangedHint") : undefined}
        >
          <input
            type="password"
            value={softwarePin}
            onChange={(e) => setSoftwarePin(e.target.value)}
            autoComplete="off"
            placeholder={status.hasSoftwarePin ? "••••" : ""}
            className={inputCls}
          />
        </FieldLabel>
        <FieldLabel
          label={t("credsTechnicalKeyLabel")}
          hint={status.hasTechnicalKey ? t("credsUnchangedHint") : t("credsTechnicalKeyHint")}
        >
          <input
            type="password"
            value={technicalKey}
            onChange={(e) => setTechnicalKey(e.target.value)}
            autoComplete="off"
            placeholder={status.hasTechnicalKey ? "••••" : ""}
            className={inputCls}
          />
        </FieldLabel>
        <FieldLabel label={t("credsTestSetLabel")} hint={t("credsTestSetHint")}>
          <input
            type="text"
            value={testSetId}
            onChange={(e) => setTestSetId(e.target.value)}
            className={inputCls}
          />
        </FieldLabel>
        <FieldLabel label={t("credsEnvLabel")} hint={t("credsEnvHint")}>
          <select
            value={environment}
            onChange={(e) =>
              setEnvironment(e.target.value as "habilitacion" | "produccion")
            }
            className={inputCls}
          >
            <option value="habilitacion">{t("envHabilitacion")}</option>
            <option value="produccion">{t("envProduccion")}</option>
          </select>
        </FieldLabel>
      </div>

      <div className="flex items-center justify-end gap-3 mt-4">
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
          disabled={busy || !canSave}
          className="mp-btn mp-btn--primary mp-btn--sm"
        >
          {busy ? t("saving") : t("save")}
        </button>
      </div>
    </section>
  );
}

// ── Paso 3 · Habilitación ───────────────────────────────────────────────

function HabilitacionSection({
  t,
  status,
  canSave,
  onDone,
}: {
  t: ReturnType<typeof useTranslations>;
  status: DianStatus;
  canSave: boolean;
  onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Solo visible con certificado + credenciales + testSetId + habilitación.
  const ready =
    status.hasCertificate &&
    status.hasSoftwareId &&
    status.hasSoftwarePin &&
    status.hasTechnicalKey &&
    !!status.testSetId &&
    status.environment === "habilitacion";

  if (!ready) {
    return (
      <section className="rounded-2xl border border-op-border bg-op-surface p-5">
        <StepHeader index={3} title={t("habTitle")} t={t} />
        <p className="text-xs text-op-muted mt-1">{t("habNotReady")}</p>
        {(status.status === "testing" || status.status === "enabled") && (
          <div className="mt-3">
            <StatusBadge status={status.status} t={t} />
          </div>
        )}
      </section>
    );
  }

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    const r = await fetch("/api/operator/dian/test-set", { method: "POST" });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setError(mapError(t, j.error));
      return;
    }
    const j = (await r.json()) as { result: TestResult };
    setResult(j.result);
    await onDone();
  }

  const ok = result && (result.state === "accepted" || result.state === "pending");

  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-5">
      <StepHeader index={3} title={t("habTitle")} t={t} />
      <p className="text-xs text-op-muted mt-1 mb-3">{t("habHelp")}</p>

      {(status.status === "testing" || status.status === "enabled") && (
        <div className="mb-3">
          <StatusBadge status={status.status} t={t} />
        </div>
      )}

      <button
        type="button"
        onClick={run}
        disabled={busy || !canSave}
        className="mp-btn mp-btn--primary mp-btn--sm"
      >
        {busy && (
          <span
            className="inline-block w-3.5 h-3.5 rounded-full border-2 border-bone/40 border-t-bone animate-spin"
            aria-hidden="true"
          />
        )}
        {busy ? t("habRunning") : t("habRun")}
      </button>

      {error && (
        <div className="mt-4">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      {result && (
        <div
          className={
            "mt-4 rounded-xl border p-4 " +
            (ok
              ? "border-ok/40 bg-ok/10"
              : "border-danger/40 bg-danger/10")
          }
        >
          <div className={"text-sm font-medium " + (ok ? "text-ok" : "text-danger")}>
            {result.state === "accepted"
              ? t("habResultAccepted")
              : result.state === "pending"
                ? t("habResultPending")
                : t("habResultRejected")}
          </div>
          {result.statusMessage && (
            <div className="text-xs text-op-muted mt-1">{result.statusMessage}</div>
          )}
          {ok && result.cufe && (
            <div className="text-[11px] font-mono break-all mt-2 text-op-muted">
              {t("habCufe", { cufe: result.cufe })}
            </div>
          )}
          {!ok && result.errors.length > 0 && (
            <ul className="list-disc list-inside text-xs text-danger mt-2 space-y-1">
              {result.errors.map((e, i) => (
                <li key={i} className="break-words">
                  {e}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ── Piezas compartidas ──────────────────────────────────────────────────

function StepHeader({
  index,
  title,
  t,
}: {
  index: number;
  title: string;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-7 h-7 shrink-0 rounded-full bg-ink text-bone text-xs font-mono inline-flex items-center justify-center">
        {index}
      </span>
      <h2 className="font-display text-lg">
        {t("stepLabel", { index, title })}
      </h2>
    </div>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: "pending" | "testing" | "enabled";
  t: ReturnType<typeof useTranslations>;
}) {
  const tint =
    status === "enabled"
      ? "bg-ok/15 text-ok"
      : status === "testing"
        ? "bg-[#C98A2E]/20 text-[#8F6828]"
        : "bg-paper text-op-muted";
  const label =
    status === "enabled"
      ? t("statusEnabled")
      : status === "testing"
        ? t("statusTesting")
        : t("statusPending");
  return (
    <span
      className={
        "px-3 h-6 inline-flex items-center rounded-full text-[11px] font-medium " +
        tint
      }
    >
      {label}
    </span>
  );
}

function FieldLabel({
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

function Banner({
  tone,
  children,
}: {
  tone: "error" | "warning";
  children: React.ReactNode;
}) {
  const cls =
    tone === "error"
      ? "border-danger/40 bg-danger/10 text-danger"
      : "border-[#C98A2E]/40 bg-[#C98A2E]/10 text-[#8F6828]";
  return (
    <div className={"rounded-xl border p-3 text-sm " + cls} role="alert">
      {children}
    </div>
  );
}

const inputCls =
  "w-full h-10 px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";

/** Mapea los códigos de error de la API a mensajes i18n legibles. */
function mapError(t: ReturnType<typeof useTranslations>, code?: string): string {
  switch (code) {
    case "module_disabled":
      return t("errModuleDisabled");
    case "master_key_missing":
      return t("masterKeyNotReady");
    case "no_emisor":
      return t("errNoEmisor");
    case "invalid":
      return t("errInvalid");
    case "bad_size":
      return t("errBadSize");
    case "bad_password":
      return t("errBadPassword");
    case "no_key":
      return t("errNoKey");
    case "no_cert":
      return t("errNoCert");
    case "no_test_set":
      return t("errNoTestSet");
    case "not_habilitacion":
      return t("errNotHabilitacion");
    case "emisor_incomplete":
      return t("errEmisorIncomplete");
    case "no_certificate":
      return t("errNoCertificate");
    case "missing_credentials":
      return t("errMissingCredentials");
    case "decrypt_failed":
      return t("errDecryptFailed");
    default:
      return t("errGeneric");
  }
}
