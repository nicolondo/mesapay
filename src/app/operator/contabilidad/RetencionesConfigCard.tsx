"use client";

// Contabilidad › Impuestos › «Retenciones (conceptos)»: los conceptos de
// retención del comercio (retefuente / reteIVA / reteICA), el valor UVT, y
// la hoja para CREAR un concepto —desde el catálogo de Colombia del año
// (retencionesCatalogo.ts) o personalizado— y para editarlo o borrarlo.
// Los activos se sugieren solos en compras y gastos y alimentan la revisión
// «retención omitida / bajo umbral» de Impuestos del período.

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney, formatNumber } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import {
  RETENTION_CATALOG,
  RETENTION_CATALOG_UVT_PESOS,
  RETENTION_CATALOG_YEAR,
  retentionCatalogEntry,
  type RetentionCatalogEntry,
} from "@/lib/erp/retencionesCatalogo";
import {
  RETENTION_KINDS,
  baseForKind,
  normalizeConceptName,
  parseRateToPpm,
  ppmToRate,
  rateUnitFor,
  validateConceptFields,
  type ConceptFieldError,
  type RetentionKind,
} from "@/lib/erp/retencionesCore";

export type RetConcept = {
  id: string;
  kind: string;
  name: string;
  /** Tarifa efectiva en bps (puede tener decimales). */
  rateBps: number;
  /** Tarifa exacta en partes por millón. */
  ratePpm: number;
  base: string;
  thresholdUvt: number;
  accountCode: string;
  active: boolean;
  catalogKey: string | null;
  isCustom: boolean;
  usedCount: number;
};

type RetAccount = { code: string; name: string; kind: RetentionKind };

/** Cuenta que trae el plan base para cada tipo (la de respaldo). */
const DEFAULT_ACCOUNT: Record<RetentionKind, string> = {
  retefuente: "236505",
  reteiva: "236705",
  reteica: "236805",
};

const KIND_KEYS: Record<RetentionKind, string> = {
  retefuente: "invTaxRetefuente",
  reteiva: "invTaxReteIva",
  reteica: "invTaxReteIca",
};

const labelCls = "font-mono text-[10px] tracking-wider uppercase text-op-muted";
const inputCls =
  "mt-1 w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40 disabled:opacity-60";

/** Tarifa legible: «2,5 %» o, la reteICA, «4,14 ×1.000». */
function useRateText() {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  return (kind: string, ratePpm: number) => {
    const unit = rateUnitFor(kind);
    const rate = formatNumber(ppmToRate(ratePpm, unit), { locale, maximumFractionDigits: 4 });
    return unit === "permil" ? t("retRatePerMil", { rate }) : t("retRatePct", { rate });
  };
}

/**
 * Conceptos de retención (retefuente/reteIVA/reteICA) del comercio + valor
 * UVT. El contador activa los que apliquen y crea los que falten; los
 * activos alimentan la sugerencia automática en compras y gastos.
 */
export function RetencionesConfigCard({ currency }: { currency: string }) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const rateText = useRateText();
  const [concepts, setConcepts] = useState<RetConcept[] | null>(null);
  const [accounts, setAccounts] = useState<RetAccount[]>([]);
  const [uvtCents, setUvtCents] = useState<number | null>(null);
  const [uvtRaw, setUvtRaw] = useState("");
  const [err, setErr] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Hoja abierta: crear (null) o editar (el concepto). */
  const [sheet, setSheet] = useState<{ concept: RetConcept | null } | null>(null);

  async function load() {
    const r = await fetch("/api/operator/accounting/retenciones");
    if (!r.ok) throw new Error("load");
    const j = await r.json();
    setConcepts(j.concepts as RetConcept[]);
    setAccounts((j.accounts as RetAccount[] | undefined) ?? []);
    setUvtCents(j.uvtCents as number);
  }

  useEffect(() => {
    let alive = true;
    fetch("/api/operator/accounting/retenciones")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("load"))))
      .then((j) => {
        if (!alive) return;
        setConcepts(j.concepts as RetConcept[]);
        setAccounts((j.accounts as RetAccount[] | undefined) ?? []);
        setUvtCents(j.uvtCents as number);
      })
      .catch(() => {
        if (alive) setErr(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function patch(body: Record<string, unknown>, busyKey: string) {
    setBusyId(busyKey);
    const r = await fetch("/api/operator/accounting/retenciones", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusyId(null);
    if (!r.ok) {
      setErr(true);
      return;
    }
    const j = await r.json();
    setConcepts(j.concepts as RetConcept[]);
    setUvtCents(j.uvtCents as number);
  }

  async function saveUvt() {
    const pesos = Number(uvtRaw.replace(/\D/g, ""));
    if (!pesos) return;
    await patch({ uvtCents: pesos * 100 }, "uvt");
    setUvtRaw("");
  }

  return (
    <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden" data-testid="retenciones-card">
      <div className="border-b border-op-border bg-op-bg px-4 py-2 flex items-center justify-between gap-3">
        <span className="font-display text-lg">{t("retTitle")}</span>
        <button
          type="button"
          onClick={() => setSheet({ concept: null })}
          disabled={concepts === null}
          className="mp-btn mp-btn--primary mp-btn--sm shrink-0"
        >
          {t("retNew")}
        </button>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-xs text-op-muted">{t("retIntro")}</p>
        {err ? (
          <div className="text-sm text-danger">{t("errLoadFailed")}</div>
        ) : concepts === null ? (
          <div className="text-sm text-op-muted">{t("loadingEllipsis")}</div>
        ) : (
          <>
            {concepts.length === 0 ? (
              <p className="text-sm text-op-muted">{t("retEmpty")}</p>
            ) : (
              <div className="divide-y divide-op-border/60 border-y border-op-border/60">
                {concepts.map((c) => (
                  <div key={c.id} className="flex items-center justify-between gap-2 py-2">
                    <button
                      type="button"
                      onClick={() => setSheet({ concept: c })}
                      className="min-w-0 flex-1 text-left min-h-[44px]"
                      aria-label={t("retEditAria", { name: c.name })}
                    >
                      <div className="text-sm break-words">
                        {c.name}
                        {c.isCustom && (
                          <span className="ml-2 align-middle rounded-full border border-op-border px-1.5 py-0.5 text-[10px] text-op-muted">
                            {t("retCustomBadge")}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-op-muted break-words">
                        {[
                          rateText(c.kind, c.ratePpm),
                          c.base === "tax" ? t("retBaseTax") : t("retBaseSubtotal"),
                          c.thresholdUvt > 0 ? t("retThreshold", { uvt: c.thresholdUvt }) : t("retNoThreshold"),
                          c.accountCode,
                        ].join(" · ")}
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => patch({ conceptId: c.id, active: !c.active }, c.id)}
                      disabled={busyId === c.id}
                      aria-pressed={c.active}
                      aria-label={t("retToggleAria", { name: c.name })}
                      className={
                        "px-3 h-8 rounded-full text-xs font-medium shrink-0 border " +
                        (c.active ? "bg-ok/15 text-ok border-ok/30" : "bg-op-bg text-op-muted border-op-border")
                      }
                    >
                      {c.active ? t("retActive") : t("retInactive")}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2">
              <label className="block flex-1">
                <span className={labelCls}>
                  {t("retUvtLabel", {
                    current: uvtCents != null ? formatMoney(uvtCents, { currency, locale }) : "…",
                  })}
                </span>
                <MoneyInput
                  value={uvtRaw}
                  onChange={(raw) => setUvtRaw(raw)}
                  placeholder={t("retUvtPlaceholder")}
                  className="mt-1 w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm tabular"
                />
              </label>
              <button
                type="button"
                onClick={saveUvt}
                disabled={busyId === "uvt" || uvtRaw.trim() === ""}
                className="mp-btn mp-btn--secondary mp-btn--sm px-4"
              >
                {t("save")}
              </button>
            </div>
          </>
        )}
      </div>

      {sheet && concepts && (
        <ConceptSheet
          concept={sheet.concept}
          concepts={concepts}
          accounts={accounts}
          uvtCents={uvtCents ?? RETENTION_CATALOG_UVT_PESOS * 100}
          currency={currency}
          onClose={() => setSheet(null)}
          onSaved={async () => {
            setSheet(null);
            await load().catch(() => setErr(true));
          }}
        />
      )}
    </div>
  );
}

/* ─────────────────────── Hoja: crear / editar ─────────────────────── */

type Draft = {
  kind: RetentionKind;
  name: string;
  rateRaw: string;
  thresholdRaw: string;
  accountCode: string;
  active: boolean;
  catalogKey: string | null;
};

/** Mensaje de cada error del API (o de la validación local). */
const ERROR_KEYS: Partial<Record<ConceptFieldError | "concept_in_use", string>> = {
  name_invalid: "retErrName",
  name_taken: "retErrNameTaken",
  rate_invalid: "retErrRate",
  threshold_invalid: "retErrThreshold",
  account_invalid: "retErrAccount",
  concept_in_use: "retErrInUse",
};

function ConceptSheet({
  concept,
  concepts,
  accounts,
  uvtCents,
  currency,
  onClose,
  onSaved,
}: {
  /** null = crear. */
  concept: RetConcept | null;
  concepts: RetConcept[];
  accounts: RetAccount[];
  uvtCents: number;
  currency: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const rateText = useRateText();
  const money = (c: number) => formatMoney(c, { currency, locale });
  const editing = concept !== null;

  const fmtRateInput = (kind: string, ppm: number) =>
    formatNumber(ppmToRate(ppm, rateUnitFor(kind)), { locale, maximumFractionDigits: 4 }).replace(/\s/g, "");

  /** Cuenta inicial: la sugerida si el plan la tiene; si no, la del tipo. */
  const accountFor = (kind: RetentionKind, suggested: string | null) => {
    const mine = accounts.filter((a) => a.kind === kind).map((a) => a.code);
    if (suggested && mine.includes(suggested)) return suggested;
    if (mine.includes(DEFAULT_ACCOUNT[kind])) return DEFAULT_ACCOUNT[kind];
    return mine[0] ?? "";
  };

  const [mode, setMode] = useState<"catalog" | "custom" | "form">(editing ? "form" : "catalog");
  const [draft, setDraft] = useState<Draft>(() =>
    concept
      ? {
          kind: (RETENTION_KINDS as readonly string[]).includes(concept.kind)
            ? (concept.kind as RetentionKind)
            : "retefuente",
          name: concept.name,
          rateRaw: fmtRateInput(concept.kind, concept.ratePpm),
          thresholdRaw: String(concept.thresholdUvt),
          accountCode: concept.accountCode,
          active: concept.active,
          catalogKey: concept.catalogKey,
        }
      : {
          kind: "retefuente",
          name: "",
          rateRaw: "",
          thresholdRaw: "0",
          accountCode: accountFor("retefuente", null),
          active: true,
          catalogKey: null,
        },
  );
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const catalogName = (e: RetentionCatalogEntry) => t(`retCat_${e.key}`);
  const haveKeys = new Set(concepts.map((c) => c.catalogKey).filter(Boolean));
  const catalogEntry = retentionCatalogEntry(draft.catalogKey);

  function pickCatalog(e: RetentionCatalogEntry) {
    setError(null);
    setDraft({
      kind: e.kind,
      name: catalogName(e),
      rateRaw: e.ratePpm != null ? fmtRateInput(e.kind, e.ratePpm) : "",
      thresholdRaw: String(e.thresholdUvt),
      accountCode: accountFor(e.kind, e.accountCode),
      active: true,
      catalogKey: e.key,
    });
    setMode("form");
  }

  function startCustom() {
    setError(null);
    setDraft({
      kind: "retefuente",
      name: "",
      rateRaw: "",
      thresholdRaw: "0",
      accountCode: accountFor("retefuente", null),
      active: true,
      catalogKey: null,
    });
    setMode("custom");
  }

  const unit = rateUnitFor(draft.kind);
  const ratePpm = parseRateToPpm(draft.rateRaw, unit);
  const thresholdUvt = /^\d+$/.test(draft.thresholdRaw.trim()) ? Number(draft.thresholdRaw.trim()) : NaN;
  const kindAccounts = accounts.filter((a) => a.kind === draft.kind);
  // Un concepto viejo puede tener una cuenta que ya no está entre las
  // imputables: se muestra igual para no cambiarla sin querer.
  const accountOptions =
    draft.accountCode && !kindAccounts.some((a) => a.code === draft.accountCode)
      ? [{ code: draft.accountCode, name: "", kind: draft.kind }, ...kindAccounts]
      : kindAccounts;
  const suggestedMissing =
    catalogEntry && !kindAccounts.some((a) => a.code === catalogEntry.accountCode) ? catalogEntry.accountCode : null;

  const localError: ConceptFieldError | null = validateConceptFields(
    {
      kind: draft.kind,
      name: draft.name,
      ratePpm: ratePpm ?? 0,
      base: baseForKind(draft.kind),
      thresholdUvt,
      accountCode: draft.accountCode,
    },
    {
      others: concepts.filter((c) => c.id !== concept?.id),
      allowedAccounts: accountOptions.map((a) => a.code),
    },
  );

  // Ejemplo: sobre la base mínima (o $1.000.000 si es menor), cuánto retiene.
  const examplePesos = Math.max(1_000_000, Number.isFinite(thresholdUvt) ? thresholdUvt * (uvtCents / 100) : 0);
  const exampleCents = examplePesos * 100;
  const exampleAmount = ratePpm != null ? Math.round((exampleCents * ratePpm) / 1_000_000) : null;

  async function submit() {
    if (localError) {
      setError(t(ERROR_KEYS[localError] ?? "errSaveFailed"));
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      name: draft.name,
      ratePpm,
      thresholdUvt,
      accountCode: draft.accountCode,
      active: draft.active,
    };
    const r = editing
      ? await fetch(`/api/operator/accounting/retenciones/conceptos/${encodeURIComponent(concept.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      : await fetch("/api/operator/accounting/retenciones/conceptos", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, kind: draft.kind, catalogKey: draft.catalogKey }),
        });
    setBusy(false);
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setError(t(ERROR_KEYS[j.error as ConceptFieldError] ?? "errSaveFailed"));
      return;
    }
    await onSaved();
  }

  async function remove() {
    if (!concept) return;
    if (!window.confirm(t("retDeleteConfirm", { name: concept.name }))) return;
    setBusy(true);
    setError(null);
    const r = await fetch(`/api/operator/accounting/retenciones/conceptos/${encodeURIComponent(concept.id)}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setError(t(ERROR_KEYS[j.error as "concept_in_use"] ?? "errSaveFailed"));
      return;
    }
    await onSaved();
  }

  // Catálogo filtrado por lo que se escribe (nombre, tipo o tarifa).
  const q = normalizeConceptName(query);
  const filtered = q
    ? RETENTION_CATALOG.filter((e) => {
        const hay = normalizeConceptName(
          [t(`retCat_${e.key}`), t(KIND_KEYS[e.kind]), e.ratePpm != null ? rateText(e.kind, e.ratePpm) : ""].join(" "),
        );
        return q.split(" ").every((w) => hay.includes(w));
      })
    : RETENTION_CATALOG;

  const title = editing ? t("retSheetEditTitle") : t("retSheetNewTitle");

  return (
    <div
      // Sin cierre al tocar afuera: es un formulario, y un clic perdido borraba lo digitado.
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
    >
      <div
        className="w-full md:max-w-xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto overscroll-contain"
        style={{ paddingBottom: "calc(1.25rem + env(safe-area-inset-bottom, 0px))" }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 className="font-display text-2xl">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>

        {!editing && (
          <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl border border-op-border bg-op-bg p-1" role="group">
            <button
              type="button"
              onClick={() => setMode("catalog")}
              aria-pressed={mode === "catalog" || (mode === "form" && draft.catalogKey !== null)}
              className={
                "min-h-[40px] rounded-lg text-sm font-medium " +
                (mode === "catalog" || (mode === "form" && draft.catalogKey !== null)
                  ? "bg-op-surface shadow-sm"
                  : "text-op-muted")
              }
            >
              {t("retTabCatalog")}
            </button>
            <button
              type="button"
              onClick={startCustom}
              aria-pressed={mode === "custom"}
              className={"min-h-[40px] rounded-lg text-sm font-medium " + (mode === "custom" ? "bg-op-surface shadow-sm" : "text-op-muted")}
            >
              {t("retTabCustom")}
            </button>
          </div>
        )}

        {mode === "catalog" ? (
          <div className="space-y-3">
            <p className="text-xs text-op-muted">
              {t("retCatalogIntro", {
                year: RETENTION_CATALOG_YEAR,
                uvt: formatMoney(RETENTION_CATALOG_UVT_PESOS * 100, { currency, locale }),
              })}
            </p>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("retCatalogSearch")}
              aria-label={t("retCatalogSearch")}
              className={inputCls}
            />
            {filtered.length === 0 ? (
              <p className="text-sm text-op-muted">{t("retCatalogEmpty", { q: query })}</p>
            ) : (
              RETENTION_KINDS.map((kind) => {
                const items = filtered.filter((e) => e.kind === kind);
                if (items.length === 0) return null;
                return (
                  <div key={kind} className="space-y-1.5">
                    <div className={labelCls}>{t(KIND_KEYS[kind])}</div>
                    <ul className="space-y-1.5">
                      {items.map((e) => {
                        const have = haveKeys.has(e.key);
                        return (
                          <li key={e.key}>
                            <button
                              type="button"
                              onClick={() => pickCatalog(e)}
                              disabled={have}
                              className="w-full text-left rounded-xl border border-op-border bg-op-bg/40 px-3 py-2 hover:border-op-text/40 disabled:opacity-60"
                              data-testid={`ret-cat-${e.key}`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <span className="text-sm font-medium">{catalogName(e)}</span>
                                <span className="shrink-0 font-mono text-sm tabular">
                                  {e.ratePpm != null ? rateText(e.kind, e.ratePpm) : t("retCatalogRateAsk")}
                                </span>
                              </div>
                              <div className="text-[11px] text-op-muted">
                                {[
                                  e.base === "tax" ? t("retBaseTax") : t("retBaseSubtotal"),
                                  e.thresholdUvt > 0
                                    ? t("retCatalogMin", {
                                        uvt: e.thresholdUvt,
                                        amount: money(e.thresholdUvt * RETENTION_CATALOG_UVT_PESOS * 100),
                                      })
                                    : t("retCatalogNoMin"),
                                  t("retCatalogAccount", { code: e.accountCode }),
                                ].join(" · ")}
                              </div>
                              {e.hasNote && <div className="mt-1 text-[11px] text-op-muted">{t(`retCatNote_${e.key}`)}</div>}
                              {have && <div className="mt-1 text-[11px] font-medium text-ok">{t("retCatalogHave")}</div>}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })
            )}
            <p className="text-[11px] text-op-muted">{t("retCatalogMissing")}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {catalogEntry && !editing && (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-op-border bg-op-bg/40 px-3 py-2">
                <span className="text-xs">{t("retFromCatalog", { name: t(`retCat_${catalogEntry.key}`) })}</span>
                <button
                  type="button"
                  onClick={() => setMode("catalog")}
                  className="text-xs font-medium underline underline-offset-2 min-h-[32px] shrink-0"
                >
                  {t("retChangeCatalog")}
                </button>
              </div>
            )}
            {catalogEntry?.hasNote && (
              <p className="text-[11px] text-op-muted">{t(`retCatNote_${catalogEntry.key}`)}</p>
            )}

            <label className="block">
              <span className={labelCls}>{t("retFieldKind")}</span>
              <select
                value={draft.kind}
                disabled={editing || draft.catalogKey !== null}
                onChange={(e) => {
                  const kind = e.target.value as RetentionKind;
                  setDraft((d) => ({ ...d, kind, accountCode: accountFor(kind, null) }));
                }}
                className={inputCls}
              >
                {RETENTION_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(KIND_KEYS[k])}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={labelCls}>{t("retFieldName")}</span>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                maxLength={120}
                placeholder={t("retFieldNamePlaceholder")}
                className={inputCls}
              />
            </label>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={labelCls}>{unit === "permil" ? t("retFieldRatePerMil") : t("retFieldRatePct")}</span>
                <div className="relative">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={draft.rateRaw}
                    onChange={(e) => setDraft((d) => ({ ...d, rateRaw: e.target.value }))}
                    placeholder={unit === "permil" ? "4,14" : "1"}
                    aria-describedby="ret-rate-hint"
                    className={inputCls + " pr-10 text-right tabular"}
                  />
                  <span className="pointer-events-none absolute right-3 top-1/2 mt-0.5 -translate-y-1/2 text-sm text-op-muted">
                    {unit === "permil" ? "‰" : "%"}
                  </span>
                </div>
                <span id="ret-rate-hint" className="mt-1 block text-[11px] text-op-muted">
                  {unit === "permil" ? t("retRateHintPerMil") : t("retRateHintPct")}
                </span>
              </label>
              <label className="block">
                <span className={labelCls}>{t("retFieldThreshold")}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={draft.thresholdRaw}
                  onChange={(e) => setDraft((d) => ({ ...d, thresholdRaw: e.target.value.replace(/\D/g, "") }))}
                  className={inputCls + " text-right tabular"}
                />
                <span className="mt-1 block text-[11px] text-op-muted">
                  {Number.isFinite(thresholdUvt) && thresholdUvt > 0
                    ? t("retThresholdHint", { uvt: thresholdUvt, amount: money(thresholdUvt * uvtCents) })
                    : t("retThresholdZero")}
                </span>
              </label>
            </div>

            <div>
              <span className={labelCls}>{t("retFieldBase")}</span>
              <p className="mt-1 text-sm">{draft.kind === "reteiva" ? t("retBaseTaxLong") : t("retBaseSubtotalLong")}</p>
            </div>

            <label className="block">
              <span className={labelCls}>{t("retFieldAccount")}</span>
              <select
                value={draft.accountCode}
                onChange={(e) => setDraft((d) => ({ ...d, accountCode: e.target.value }))}
                className={inputCls}
              >
                {accountOptions.map((a) => (
                  <option key={a.code} value={a.code}>
                    {a.name ? `${a.code} · ${a.name}` : a.code}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-[11px] text-op-muted">
                {accountOptions.length === 0
                  ? t("retAccountNone")
                  : suggestedMissing
                    ? t("retAccountSuggestedMissing", { code: suggestedMissing, fallback: draft.accountCode })
                    : t("retAccountHint")}
              </span>
            </label>

            <label className="flex items-start gap-3 min-h-[44px] cursor-pointer">
              <input
                type="checkbox"
                checked={draft.active}
                onChange={(e) => setDraft((d) => ({ ...d, active: e.target.checked }))}
                className="mt-1 h-5 w-5 shrink-0"
              />
              <span className="text-sm">{t("retFieldActive")}</span>
            </label>

            {exampleAmount != null && (
              <p className="rounded-xl bg-op-bg px-3 py-2 text-xs" aria-live="polite" data-testid="ret-example">
                {t(draft.kind === "reteiva" ? "retExampleTax" : "retExample", {
                  base: money(exampleCents),
                  amount: money(exampleAmount),
                })}
              </p>
            )}

            {editing && (
              <p className="text-[11px] text-op-muted">
                {concept.usedCount > 0 ? t("retInUse", { count: concept.usedCount }) : t("retEditNote")}
              </p>
            )}

            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}

            <div className="flex flex-col-reverse gap-3 pt-1 sm:flex-row sm:items-center">
              {editing && concept.usedCount === 0 && (
                <button type="button" onClick={remove} disabled={busy} className="mp-btn mp-btn--danger">
                  {t("retDelete")}
                </button>
              )}
              <div className="hidden sm:block sm:flex-1" />
              <div className="grid grid-cols-2 gap-3 sm:flex">
                <button type="button" onClick={onClose} className="mp-btn mp-btn--secondary">
                  {t("cancel")}
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={busy}
                  className="mp-btn mp-btn--primary"
                  data-testid="ret-submit"
                >
                  {busy ? t("saving") : editing ? t("save") : t("retCreate")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
