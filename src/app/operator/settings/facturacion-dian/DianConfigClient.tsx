"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import type { Locale } from "@/i18n/config";
import { DANE_CITIES, DANE_DEPARTMENTS } from "@/lib/dian/dane";
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
  missingResolution: string[];
  missingLocation: string[];
  einvoicingEnabled: boolean;
};

type Emisor = {
  kind: "legalEntity" | "restaurant";
  legalName: string | null;
  taxId: string | null;
  cityName: string | null;
  /** Texto libre legacy — ya no se edita, sólo se muestra si contradice. */
  resolution: string | null;
  resolutionNumber: string | null;
  resolutionFrom: number | null;
  resolutionTo: number | null;
  resolutionValidFrom: string | null;
  resolutionValidTo: string | null;
  resolutionDate: string | null;
  daneCityCode: string | null;
  invoicePrefix: string | null;
  invoiceNextNumber: number;
  legacyResolutionConflict: string | null;
} | null;

/** Documento enviado a la DIAN, tal como quedó persistido. */
type DianDocument = {
  id: string;
  state: string;
  cufe: string | null;
  trackId: string | null;
  errors: string[];
  statusMessage: string | null;
  createdAt?: string;
  updatedAt?: string;
};

type DianView = {
  status: DianStatus;
  emisor: Emisor;
  lastDocument: DianDocument | null;
  masterKeyReady: boolean;
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
      {/* Aviso: el server no puede cifrar secretos todavía. Sólo importa
          cuando hay credenciales que cifrar. */}
      {status.einvoicingEnabled && !masterKeyReady && (
        <Banner tone="error">{t("masterKeyNotReady")}</Banner>
      )}

      {/* Estado general */}
      {status.einvoicingEnabled && (
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
      )}

      {/* Emisor (solo lectura) */}
      <EmisorSection t={t} emisor={emisor} missing={status.missingEmisor} />

      {/* Resolución de numeración — ÚNICA superficie de carga. */}
      <ResolutionSection
        t={t}
        emisor={emisor}
        missing={status.missingResolution}
        missingLocation={status.missingLocation}
        onSaved={load}
      />

      {/* Certificado, credenciales y habilitación sólo aplican con el
          módulo de facturación electrónica activo. Sin él la pantalla
          existe igual, porque la resolución de arriba la necesita
          cualquier comercio que imprima comprobante. */}
      {status.einvoicingEnabled && (
        <>
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
          <HabilitacionSection
            t={t}
            locale={locale}
            status={status}
            lastDocument={view.lastDocument}
            canSave={canSave}
            onDone={load}
          />
        </>
      )}
    </div>
  );
}

// ── Emisor ──────────────────────────────────────────────────────────────

// Sólo lo que se carga en IDENTIDAD. La resolución y el prefijo salieron
// de esa lista porque ya no se editan ahí: se avisan con
// `missingResolution`, que es lo que de verdad bloquea el envío.
const EMISOR_LABEL_KEY: Record<string, string> = {
  legalName: "emisorLegalName",
  taxId: "emisorTaxId",
  addressLine: "emisorAddress",
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
        <ReadonlyField label={t("emisorCity")} value={emisor?.cityName} t={t} />
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

// ── Resolución de numeración ────────────────────────────────────────────
//
// ÚNICA superficie de carga de la resolución. Antes estaba partida entre
// Identidad (texto libre + rango + fecha + prefijo + consecutivo) y esta
// pantalla (número + vigencia). Un comercio cargó 18764094877213 en
// Identidad creyendo que era la resolución mientras el XML que se le
// mandaba a la DIAN llevaba 18760000001, y desde la UI no había forma de
// notarlo.
//
// La DIAN contrasta estos datos contra la resolución vigente del
// contribuyente. Si alguno no coincide rechaza el documento entero (reglas
// FAB05b, FAB07b, FAB08b, FAB10b, FAB11b, FAB12b, FAD05c). No hay forma de
// deducirlos: hay que copiarlos de la resolución que expide la DIAN.

const RESOLUTION_LABEL_KEY: Record<string, string> = {
  resolutionNumber: "resolutionNumberLabel",
  invoicePrefix: "resolutionPrefixLabel",
  resolutionFrom: "resolutionFromLabel",
  resolutionTo: "resolutionToLabel",
  resolutionValidFrom: "resolutionValidFromLabel",
  resolutionValidTo: "resolutionValidToLabel",
};

const LOCATION_LABEL_KEY: Record<string, string> = {
  daneCityCode: "daneCityLabel",
  cityName: "emisorCity",
};

/** Valor del <select> que revela el campo de código libre. */
const DANE_OTHER = "__other";

type ResolutionDraft = {
  resolutionNumber: string;
  invoicePrefix: string;
  resolutionFrom: string;
  resolutionTo: string;
  resolutionValidFrom: string;
  resolutionValidTo: string;
  resolutionDate: string;
  invoiceNextNumber: string;
  daneCityCode: string;
};

function ResolutionSection({
  t,
  emisor,
  missing,
  missingLocation,
  onSaved,
}: {
  t: ReturnType<typeof useTranslations>;
  emisor: Emisor;
  missing: string[];
  missingLocation: string[];
  onSaved: () => Promise<void>;
}) {
  // Si el número todavía no está pero el texto legacy de la tirilla ya es
  // un número pelado, se propone como valor inicial. No se guarda solo: el
  // operador confirma con Guardar.
  const suggestedNumber =
    emisor?.resolution && /^\d+$/.test(emisor.resolution.trim())
      ? emisor.resolution.trim()
      : "";
  const [draft, setDraft] = useState<ResolutionDraft>({
    resolutionNumber: emisor?.resolutionNumber ?? suggestedNumber,
    invoicePrefix: emisor?.invoicePrefix ?? "",
    resolutionFrom: emisor?.resolutionFrom?.toString() ?? "",
    resolutionTo: emisor?.resolutionTo?.toString() ?? "",
    resolutionValidFrom: emisor?.resolutionValidFrom ?? "",
    resolutionValidTo: emisor?.resolutionValidTo ?? "",
    resolutionDate: emisor?.resolutionDate ?? "",
    invoiceNextNumber: (emisor?.invoiceNextNumber ?? 1).toString(),
    daneCityCode: emisor?.daneCityCode ?? "",
  });
  // El municipio se elige de la lista acotada; "otro" abre el campo libre
  // de 5 dígitos para los ~1.100 que no están en la lista.
  const [daneOther, setDaneOther] = useState(
    !!emisor?.daneCityCode &&
      !DANE_CITIES.some((c) => c.code === emisor.daneCityCode),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );

  function set<K extends keyof ResolutionDraft>(key: K, value: string) {
    setDraft((p) => ({ ...p, [key]: value }));
    setMsg(null);
  }

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/operator/dian/resolution", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setMsg({ kind: "error", text: mapError(t, j.error) });
      return false;
    }
    setMsg({ kind: "ok", text: t("resolutionSaved") });
    await onSaved();
    return true;
  }

  async function save() {
    await patch({
      resolutionNumber: draft.resolutionNumber.trim() || null,
      invoicePrefix: draft.invoicePrefix.trim() || null,
      resolutionFrom: draft.resolutionFrom ? Number(draft.resolutionFrom) : null,
      resolutionTo: draft.resolutionTo ? Number(draft.resolutionTo) : null,
      resolutionValidFrom: draft.resolutionValidFrom || null,
      resolutionValidTo: draft.resolutionValidTo || null,
      resolutionDate: draft.resolutionDate || null,
      invoiceNextNumber: Math.max(1, Number(draft.invoiceNextNumber) || 1),
      daneCityCode: draft.daneCityCode.trim() || null,
    });
  }

  const legacy = emisor?.legacyResolutionConflict ?? null;

  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-5">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-2">
        {t("resolutionKicker")}
      </div>
      <p className="text-xs text-op-muted mb-3">{t("resolutionHelp")}</p>

      {missing.length > 0 && (
        <div className="mb-3">
          <Banner tone="warning">
            {t("resolutionMissing", {
              fields: missing
                .map((m) =>
                  RESOLUTION_LABEL_KEY[m] ? t(RESOLUTION_LABEL_KEY[m]) : m,
                )
                .join(", "),
            })}
          </Banner>
        </div>
      )}

      {missingLocation.length > 0 && (
        <div className="mb-3">
          <Banner tone="warning">
            {t("locationMissing", {
              fields: missingLocation
                .map((m) => (LOCATION_LABEL_KEY[m] ? t(LOCATION_LABEL_KEY[m]) : m))
                .join(", "),
            })}
          </Banner>
        </div>
      )}

      {/* Dato viejo que CONTRADICE al número real. No se decide por el
          operador: se le muestran los dos y elige. Es exactamente el caso
          que motivó unificar las pantallas. */}
      {legacy && (
        <div className="mb-3">
          <Banner tone="warning">
            {t("legacyConflict", {
              legacy,
              current: emisor?.resolutionNumber ?? "",
            })}
          </Banner>
          <div className="flex flex-wrap gap-3 mt-2">
            <button
              type="button"
              onClick={() => set("resolutionNumber", legacy)}
              className="text-[11px] text-terracotta underline"
            >
              {t("legacyUse", { legacy })}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => patch({ discardLegacyResolution: true })}
              className="text-[11px] text-op-muted underline"
            >
              {t("legacyDiscard")}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <FieldLabel
          label={t("resolutionNumberLabel")}
          hint={t("resolutionNumberHint")}
        >
          <input
            type="text"
            value={draft.resolutionNumber}
            onChange={(e) => set("resolutionNumber", e.target.value)}
            className={inputCls}
          />
        </FieldLabel>
        <FieldLabel
          label={t("resolutionPrefixLabel")}
          hint={t("resolutionPrefixHint")}
        >
          <input
            type="text"
            value={draft.invoicePrefix}
            onChange={(e) => set("invoicePrefix", e.target.value.toUpperCase())}
            maxLength={10}
            className={inputCls + " uppercase"}
          />
        </FieldLabel>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FieldLabel label={t("resolutionFromLabel")}>
            <input
              type="number"
              min={0}
              value={draft.resolutionFrom}
              onChange={(e) => set("resolutionFrom", e.target.value)}
              className={inputCls}
            />
          </FieldLabel>
          <FieldLabel label={t("resolutionToLabel")}>
            <input
              type="number"
              min={0}
              value={draft.resolutionTo}
              onChange={(e) => set("resolutionTo", e.target.value)}
              className={inputCls}
            />
          </FieldLabel>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FieldLabel label={t("resolutionValidFromLabel")}>
            <input
              type="date"
              value={draft.resolutionValidFrom}
              onChange={(e) => set("resolutionValidFrom", e.target.value)}
              className={inputCls}
            />
          </FieldLabel>
          <FieldLabel label={t("resolutionValidToLabel")}>
            <input
              type="date"
              value={draft.resolutionValidTo}
              onChange={(e) => set("resolutionValidTo", e.target.value)}
              className={inputCls}
            />
          </FieldLabel>
        </div>
        {/* Fecha del acto administrativo — sólo se imprime en el
            comprobante, no va al XML. Venía de Identidad. */}
        <FieldLabel
          label={t("resolutionDateLabel")}
          hint={t("resolutionDateHint")}
        >
          <input
            type="date"
            value={draft.resolutionDate}
            onChange={(e) => set("resolutionDate", e.target.value)}
            className={inputCls}
          />
        </FieldLabel>

        {/* Ubicación DANE del establecimiento. Antes el XML mandaba Bogotá
            fijo para todos, que es lo que alimenta FAB10a/FAJ50. */}
        <FieldLabel label={t("daneCityLabel")} hint={t("daneCityHint")}>
          <select
            value={daneOther ? DANE_OTHER : draft.daneCityCode}
            onChange={(e) => {
              if (e.target.value === DANE_OTHER) {
                setDaneOther(true);
                set("daneCityCode", "");
              } else {
                setDaneOther(false);
                set("daneCityCode", e.target.value);
              }
            }}
            className={inputCls}
          >
            <option value="">{t("daneCityUnset")}</option>
            {DANE_CITIES.map((c) => (
              <option key={c.code} value={c.code}>
                {`${c.name} — ${DANE_DEPARTMENTS[c.code.slice(0, 2)]} (${c.code})`}
              </option>
            ))}
            <option value={DANE_OTHER}>{t("daneCityOther")}</option>
          </select>
          {daneOther && (
            <input
              type="text"
              inputMode="numeric"
              value={draft.daneCityCode}
              onChange={(e) =>
                set("daneCityCode", e.target.value.replace(/\D/g, "").slice(0, 5))
              }
              placeholder={t("daneCityCodePlaceholder")}
              maxLength={5}
              className={inputCls + " mt-2"}
            />
          )}
          {/* Eco del departamento derivado: los dos primeros dígitos del
              código son el departamento, así que no pueden quedar
              inconsistentes. Sirve de confirmación visual. */}
          {DANE_DEPARTMENTS[draft.daneCityCode.slice(0, 2)] && (
            <div className="text-[10px] text-op-muted mt-1">
              {t("daneDeptResolved", {
                dept: DANE_DEPARTMENTS[draft.daneCityCode.slice(0, 2)],
                code: draft.daneCityCode.slice(0, 2),
              })}
            </div>
          )}
        </FieldLabel>

        {/* Próximo consecutivo — venía de Identidad. Vive acá porque el
            rango autorizado que lo acota está en esta misma pantalla. */}
        <FieldLabel
          label={t("nextNumberLabel")}
          hint={t("nextNumberHint")}
        >
          <input
            type="number"
            min={1}
            value={draft.invoiceNextNumber}
            onChange={(e) => set("invoiceNextNumber", e.target.value)}
            className={inputCls}
          />
          {draft.invoiceNextNumber === "1" &&
            draft.resolutionFrom !== "" &&
            Number(draft.resolutionFrom) > 1 && (
              <button
                type="button"
                onClick={() =>
                  set("invoiceNextNumber", draft.resolutionFrom)
                }
                className="mt-1 text-[10px] text-terracotta underline"
              >
                {t("startFrom", { n: Number(draft.resolutionFrom) })}
              </button>
            )}
        </FieldLabel>
      </div>

      <div className="flex items-center justify-end gap-3 mt-4">
        {msg && (
          <span
            className={"text-xs " + (msg.kind === "ok" ? "text-ok" : "text-danger")}
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
    </section>
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
  locale,
  status,
  lastDocument,
  canSave,
  onDone,
}: {
  t: ReturnType<typeof useTranslations>;
  locale: Locale;
  status: DianStatus;
  lastDocument: DianDocument | null;
  canSave: boolean;
  onDone: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  // Resultado del último envío/consulta hecho en esta pantalla; si no hay,
  // se muestra el documento persistido (sobrevive a recargar la página).
  const [result, setResult] = useState<DianDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  const doc = result ?? lastDocument;

  // Solo visible con certificado + credenciales + testSetId + habilitación.
  const ready =
    status.hasCertificate &&
    status.hasSoftwareId &&
    status.hasSoftwarePin &&
    status.hasTechnicalKey &&
    !!status.testSetId &&
    status.environment === "habilitacion";

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
    const j = (await r.json()) as { result: DianDocument };
    setResult(j.result);
    await onDone();
  }

  // Consulta explícita a la DIAN (GetStatusZip). Es manual a propósito:
  // la validación es asíncrona y no tiene sentido machacar su servicio con
  // un poller — el operador consulta cuando le interesa el resultado.
  async function checkStatus(id: string) {
    setPolling(true);
    setError(null);
    const r = await fetch(`/api/operator/dian/documents/${id}/status`, {
      method: "POST",
    });
    setPolling(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setError(mapError(t, j.error));
      return;
    }
    const j = (await r.json()) as { document: DianDocument };
    setResult(j.document);
    await onDone();
  }

  // La ubicación DANE bloquea igual que la resolución: sin ella el XML
  // declararía un establecimiento que no es (FAB10a / FAJ50).
  const resolutionIncomplete =
    status.missingResolution.length > 0 || status.missingLocation.length > 0;

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
        {doc && (
          <div className="mt-4">
            <DocumentResult
              t={t}
              locale={locale}
              doc={doc}
              polling={polling}
              onCheck={checkStatus}
            />
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-5">
      <StepHeader index={3} title={t("habTitle")} t={t} />
      <p className="text-xs text-op-muted mt-1 mb-3">{t("habHelp")}</p>

      {(status.status === "testing" || status.status === "enabled") && (
        <div className="mb-3">
          <StatusBadge status={status.status} t={t} />
        </div>
      )}

      {resolutionIncomplete && (
        <div className="mb-3">
          <Banner tone="warning">
            {status.missingResolution.length > 0
              ? t("habBlockedByResolution")
              : t("habBlockedByLocation")}
          </Banner>
        </div>
      )}

      <button
        type="button"
        onClick={run}
        disabled={busy || !canSave || resolutionIncomplete}
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

      {doc && (
        <div className="mt-4">
          <DocumentResult
            t={t}
            locale={locale}
            doc={doc}
            polling={polling}
            onCheck={checkStatus}
          />
        </div>
      )}
    </section>
  );
}

/**
 * Resultado real del documento: estado, mensaje de la DIAN y — lo que
 * importa cuando rechaza — la lista completa de reglas incumplidas. Antes
 * esto no se mostraba nunca y la pantalla se quedaba en "en proceso".
 */
function DocumentResult({
  t,
  locale,
  doc,
  polling,
  onCheck,
}: {
  t: ReturnType<typeof useTranslations>;
  locale: Locale;
  doc: DianDocument;
  polling: boolean;
  onCheck: (id: string) => Promise<void>;
}) {
  const accepted = doc.state === "accepted";
  const inFlight =
    doc.state === "pending" || doc.state === "sent" || doc.state === "to_send";
  const tone = accepted
    ? "border-ok/40 bg-ok/10"
    : inFlight
      ? "border-op-border bg-op-bg"
      : "border-danger/40 bg-danger/10";
  const titleCls = accepted
    ? "text-ok"
    : inFlight
      ? "text-op-text"
      : "text-danger";
  const label = accepted
    ? t("habResultAccepted")
    : doc.state === "rejected"
      ? t("habResultRejected")
      : inFlight
        ? t("habResultPending")
        : t("habResultError");

  return (
    <div className={"rounded-xl border p-4 " + tone}>
      <div className={"text-sm font-medium " + titleCls}>{label}</div>
      {doc.statusMessage && (
        <div className="text-xs text-op-muted mt-1">{doc.statusMessage}</div>
      )}
      {doc.updatedAt && (
        <div className="text-[11px] text-op-muted mt-1">
          {t("habUpdatedAt", {
            date: formatDate(doc.updatedAt, {
              locale,
              dateStyle: "medium",
              timeStyle: "short",
            }),
          })}
        </div>
      )}
      {accepted && doc.cufe && (
        <div className="text-[11px] font-mono break-all mt-2 text-op-muted">
          {t("habCufe", { cufe: doc.cufe })}
        </div>
      )}
      {doc.trackId && (
        <div className="text-[11px] font-mono break-all mt-1 text-op-muted">
          {t("habTrackId", { trackId: doc.trackId })}
        </div>
      )}

      {doc.errors.length > 0 && (
        <div className="mt-3">
          <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
            {t("habRulesKicker", { count: doc.errors.length })}
          </div>
          <ul className="list-disc list-inside text-xs text-danger space-y-1">
            {doc.errors.map((e, i) => (
              <li key={i} className="break-words">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}

      {doc.trackId && inFlight && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => onCheck(doc.id)}
            disabled={polling}
            className="mp-btn mp-btn--ghost mp-btn--sm"
          >
            {polling ? t("habChecking") : t("habCheckStatus")}
          </button>
          <p className="text-[11px] text-op-muted mt-2">{t("habCheckHint")}</p>
        </div>
      )}
    </div>
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
    case "resolution_incomplete":
      return t("errResolutionIncomplete");
    case "location_incomplete":
      return t("errLocationIncomplete");
    case "invalid_dane_code":
      return t("errInvalidDaneCode");
    case "range_inverted":
      return t("errRangeInverted");
    case "dates_inverted":
      return t("errDatesInverted");
    case "no_track_id":
      return t("errNoTrackId");
    case "not_found":
      return t("errDocumentNotFound");
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
