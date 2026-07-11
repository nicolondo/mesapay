"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  BASE_UNIT_SYMBOL,
  DISPLAY_UNITS,
  MEASURE_KINDS,
  toBaseQty,
  type MeasureKind,
} from "@/lib/erp/units";
import { formatMoney, pesosToCents } from "@/lib/format";
import type { Locale } from "@/i18n/config";

// ── Contratos de la API (LEÍDOS de src/app/api/operator/inventory-import) ──

type ApiRow = {
  name: string;
  measureKind: MeasureKind;
  category: string | null;
  quantity: number | null;
  unit: string | null;
  unitPriceCents: number | null;
  presentationNote: string | null;
  confidence: number;
};

type ApiMatchRow = {
  row: ApiRow;
  lowConfidence: boolean;
  matchedIngredientId: string | null;
  matchedIngredientName: string | null;
  category: string | null;
};

type ImportResponse = {
  currency: "COP" | "MXN" | "unknown";
  notes: string;
  categories: string[];
  match: {
    newCount: number;
    existingCount: number;
    rows: ApiMatchRow[];
  };
};

// Clave i18n de dimensión → resuelta con t() al render (trilingüe).
const DIM_LABEL_KEYS: Record<MeasureKind, string> = {
  mass: "dimMass",
  volume: "dimVolume",
  count: "dimCount",
};

// ── Fila editable local ──
//
// La cantidad se digita en unidades display (raw string + unidad) igual que
// los sheets de inventario/compras; se convierte a base con toBaseQty al
// confirmar. El costo se digita en pesos (string) y se pasa a centavos.
type EditRow = {
  // id local estable para keys de React a través de las ediciones.
  localId: string;
  include: boolean;
  matchedIngredientId: string | null;
  matchedIngredientName: string | null;
  name: string;
  measureKind: MeasureKind;
  category: string;
  qty: string;
  unit: string;
  cost: string; // costo unitario en pesos (string digitado)
  presentationNote: string | null;
  lowConfidence: boolean;
};

/** Elige la unidad display inicial: la leída si es válida, si no la base. */
function pickUnit(kind: MeasureKind, unit: string | null): string {
  const opts = DISPLAY_UNITS[kind];
  if (unit && opts.some((u) => u.symbol === unit)) return unit;
  return BASE_UNIT_SYMBOL[kind];
}

/** Parsea un número digitado con coma o punto decimal. NaN si vacío/ inválido. */
function parseNum(raw: string): number {
  const s = raw.trim();
  if (s === "") return NaN;
  return Number(s.replace(",", "."));
}

/** Costo unitario en centavos desde el input en pesos (null si vacío/inválido). */
function costToCents(raw: string): number | null {
  const p = parseNum(raw);
  if (!isFinite(p) || p < 0) return null;
  return pesosToCents(p);
}

/** Convierte una fila editable a los números base para el resumen/confirm. */
function rowNumbers(r: EditRow): {
  qtyBase: number | null;
  unitCents: number | null;
  totalCents: number;
} {
  const qtyNum = parseNum(r.qty);
  // count: base = cantidad de unidades (toBaseQty ya lo resuelve con factor 1);
  // vacío/0 = sin stock (qtyBase 0 no siembra, contrato de /confirm).
  const qtyBase =
    isFinite(qtyNum) && qtyNum > 0
      ? toBaseQty(qtyNum, r.measureKind, r.unit)
      : 0;
  const unitCents = costToCents(r.cost);
  // Valor de la existencia = cantidad DIGITADA × costo unitario (no la base:
  // el costo es por unidad display, ej. $/kg, no $/g).
  const totalCents =
    isFinite(qtyNum) && qtyNum > 0 && unitCents != null
      ? Math.round(qtyNum * unitCents)
      : 0;
  return { qtyBase: qtyBase === null ? null : qtyBase, unitCents, totalCents };
}

// Formato de respuesta del endpoint de errores → clave i18n.
const ERR_KEY: Record<string, string> = {
  no_file: "impInvErrNoFile",
  bad_format: "impInvErrBadFormat",
  bad_size: "impInvErrBadSize",
  bad_sheet: "impInvErrBadSheet",
  module_disabled: "impInvErrModuleDisabled",
  invalid: "impInvErrInvalid",
  ingredient_not_found: "impInvErrIngredientNotFound",
};

const ACCEPT =
  ".pdf,.jpg,.jpeg,.png,.webp,.csv,.xlsx,image/*";

export function ImportInsumosSheet({
  currency,
  onClose,
  onImported,
}: {
  currency: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  type Stage = "upload" | "reading" | "review" | "confirming";
  const [stage, setStage] = useState<Stage>("upload");
  // El File se conserva en estado para poder RE-PROCESAR con otras
  // instrucciones sin volver a elegirlo.
  const [file, setFile] = useState<File | null>(null);
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [rows, setRows] = useState<EditRow[]>([]);
  const [updateExisting, setUpdateExisting] = useState(false);

  const money = (c: number) => formatMoney(c, { currency, locale });

  function toEditRows(resp: ImportResponse): EditRow[] {
    return resp.match.rows.map((m, i) => {
      const kind = m.row.measureKind;
      const unitCents = m.row.unitPriceCents;
      return {
        localId: `imp-${i}-${Math.random().toString(36).slice(2, 6)}`,
        include: true,
        matchedIngredientId: m.matchedIngredientId,
        matchedIngredientName: m.matchedIngredientName,
        name: m.row.name,
        measureKind: kind,
        category: m.category ?? m.row.category ?? "",
        qty: m.row.quantity != null ? String(m.row.quantity) : "",
        unit: pickUnit(kind, m.row.unit),
        // unitPriceCents → pesos para el input (centavos / 100).
        cost: unitCents != null ? String(Math.round(unitCents) / 100) : "",
        presentationNote: m.row.presentationNote,
        lowConfidence: m.lowConfidence,
      };
    });
  }

  async function process(reprocess: boolean) {
    if (!file) return;
    setError(null);
    setStage("reading");
    const fd = new FormData();
    fd.append("file", file);
    fd.append("instructions", instructions);
    let res: Response;
    try {
      res = await fetch("/api/operator/inventory-import", {
        method: "POST",
        body: fd,
      });
    } catch {
      setError(t("impInvErrFailed"));
      setStage(reprocess ? "review" : "upload");
      return;
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(t(ERR_KEY[j.error ?? ""] ?? "impInvErrFailed"));
      setStage(reprocess ? "review" : "upload");
      return;
    }
    const data = (await res.json()) as ImportResponse;
    const edit = toEditRows(data);
    if (edit.length === 0) {
      setError(t("impInvNoRows"));
      setStage(reprocess ? "review" : "upload");
      return;
    }
    setNotes(data.notes ?? "");
    setCategories(data.categories ?? []);
    setRows(edit);
    setStage("review");
  }

  function patch(localId: string, p: Partial<EditRow>) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.localId !== localId) return r;
        const next = { ...r, ...p };
        // Al cambiar la dimensión, la unidad digitada puede dejar de existir
        // (kg no es unidad de volumen): se resetea a la base de la nueva.
        if (p.measureKind && p.measureKind !== r.measureKind) {
          next.unit = BASE_UNIT_SYMBOL[p.measureKind];
        }
        return next;
      }),
    );
  }

  function selectAll(value: boolean) {
    setRows((prev) => prev.map((r) => ({ ...r, include: value })));
  }

  // ── Resumen (solo filas incluidas) ──
  const summary = useMemo(() => {
    let newCount = 0;
    let existingCount = 0;
    let valued = 0;
    let included = 0;
    for (const r of rows) {
      if (!r.include) continue;
      included++;
      if (r.matchedIngredientId) existingCount++;
      else newCount++;
      valued += rowNumbers(r).totalCents;
    }
    return { newCount, existingCount, valued, included };
  }, [rows]);

  async function confirm() {
    setError(null);
    const included = rows.filter((r) => r.include);
    if (included.length === 0) {
      setError(t("impInvErrNoneSelected"));
      return;
    }
    // Validación cliente: nombre no vacío; cantidad/unidad válidas cuando se
    // digitó una cantidad (0/vacío es válido → no siembra stock).
    for (const r of included) {
      if (r.name.trim().length === 0) {
        setError(t("impInvErrRowName"));
        return;
      }
      const { qtyBase } = rowNumbers(r);
      if (qtyBase === null) {
        setError(t("impInvErrRowQty"));
        return;
      }
    }

    const body = {
      rows: included.map((r) => {
        const { qtyBase, totalCents } = rowNumbers(r);
        return {
          matchedIngredientId: r.matchedIngredientId,
          name: r.name.trim(),
          measureKind: r.measureKind,
          category: r.category.trim() || null,
          qtyBase: qtyBase ?? 0,
          totalCostCents: totalCents,
        };
      }),
      updateExisting,
    };

    setStage("confirming");
    let res: Response;
    try {
      res = await fetch("/api/operator/inventory-import/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      setError(t("impInvErrFailed"));
      setStage("review");
      return;
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      setError(t(ERR_KEY[j.error ?? ""] ?? "impInvErrInvalid"));
      setStage("review");
      return;
    }
    onImported();
  }

  const busy = stage === "reading" || stage === "confirming";

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="w-full md:max-w-5xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border flex flex-col max-h-[92dvh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-5 pb-3 border-b border-op-border shrink-0">
          <div>
            <h2 className="font-display text-2xl">{t("impInvTitle")}</h2>
            <p className="text-xs text-op-muted mt-0.5 max-w-xl">
              {t("impInvIntro")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2 disabled:opacity-40"
            aria-label={t("impInvClose")}
          >
            {"✕"}
          </button>
        </div>

        {error && (
          <div className="mx-5 mt-3 p-3 rounded-xl bg-danger/10 text-danger text-sm shrink-0">
            {error}
          </div>
        )}

        {(stage === "upload" || stage === "reading") && (
          <UploadStage
            reading={stage === "reading"}
            file={file}
            instructions={instructions}
            onFile={setFile}
            onInstructions={setInstructions}
            onProcess={() => process(false)}
          />
        )}

        {(stage === "review" || stage === "confirming") && (
          <ReviewStage
            rows={rows}
            categories={categories}
            notes={notes}
            instructions={instructions}
            updateExisting={updateExisting}
            summary={summary}
            money={money}
            busy={stage === "confirming"}
            fileName={file?.name ?? null}
            onInstructions={setInstructions}
            onReprocess={() => process(true)}
            onPatch={patch}
            onSelectAll={selectAll}
            onUpdateExisting={setUpdateExisting}
            onConfirm={confirm}
          />
        )}
      </div>
    </div>
  );
}

// ── Carga ──

function UploadStage({
  reading,
  file,
  instructions,
  onFile,
  onInstructions,
  onProcess,
}: {
  reading: boolean;
  file: File | null;
  instructions: string;
  onFile: (f: File | null) => void;
  onInstructions: (v: string) => void;
  onProcess: () => void;
}) {
  const t = useTranslations("opErp");

  if (reading) {
    return (
      <div className="p-12 text-center">
        <div className="relative w-16 h-16 mx-auto mb-6">
          <div className="absolute inset-0 rounded-full bg-terracotta/15 animate-ping" />
          <div className="absolute inset-2 rounded-full bg-terracotta/25" />
          <div
            className="absolute inset-0 flex items-center justify-center text-2xl"
            aria-hidden
          >
            {"🧠"}
          </div>
        </div>
        <div className="font-display text-2xl mb-1">{t("impInvReading")}</div>
        <div className="text-sm text-op-muted">
          {file && <span className="font-mono">{file.name}</span>}
        </div>
        <div className="text-xs text-op-muted mt-2">
          {t("impInvReadingHint")}
        </div>
      </div>
    );
  }

  return (
    <div className="p-5 space-y-4 overflow-y-auto">
      <label className="block">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          {t("impInvFileLabel")}
          <span className="text-danger ml-1">{"*"}</span>
        </div>
        <label
          htmlFor="imp-inv-file"
          className="flex items-center gap-3 rounded-xl border border-dashed border-op-border bg-op-bg px-4 py-4 cursor-pointer hover:border-op-text/40"
        >
          <span className="text-2xl" aria-hidden>
            {"📄"}
          </span>
          <div className="min-w-0 flex-1">
            {file ? (
              <div className="text-sm font-medium truncate">{file.name}</div>
            ) : (
              <div className="text-sm text-op-muted">
                {t("impInvChooseFile")}
              </div>
            )}
            <div className="text-[11px] text-op-muted mt-0.5">
              {t("impInvFileHint")}
            </div>
          </div>
          {file && (
            <span className="text-xs text-terracotta shrink-0">
              {t("impInvChangeFile")}
            </span>
          )}
          <input
            id="imp-inv-file"
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              if (f) onFile(f);
              e.currentTarget.value = "";
            }}
          />
        </label>
      </label>

      <label className="block">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
          {t("impInvInstructionsLabel")}
        </div>
        <textarea
          value={instructions}
          onChange={(e) => onInstructions(e.target.value)}
          rows={3}
          maxLength={1000}
          placeholder={t("impInvInstructionsPlaceholder")}
          className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40"
        />
        <div className="text-[11px] text-op-muted mt-1">
          {t("impInvInstructionsHint")}
        </div>
      </label>

      <div className="flex items-center justify-end gap-3 pt-1">
        <button
          type="button"
          onClick={onProcess}
          disabled={!file}
          className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40 inline-flex items-center gap-1.5"
        >
          <span aria-hidden>{"✨"}</span>
          {t("impInvProcess")}
        </button>
      </div>
    </div>
  );
}

// ── Revisión (tabla densa) ──

function ReviewStage({
  rows,
  categories,
  notes,
  instructions,
  updateExisting,
  summary,
  money,
  busy,
  fileName,
  onInstructions,
  onReprocess,
  onPatch,
  onSelectAll,
  onUpdateExisting,
  onConfirm,
}: {
  rows: EditRow[];
  categories: string[];
  notes: string;
  instructions: string;
  updateExisting: boolean;
  summary: {
    newCount: number;
    existingCount: number;
    valued: number;
    included: number;
  };
  money: (c: number) => string;
  busy: boolean;
  fileName: string | null;
  onInstructions: (v: string) => void;
  onReprocess: () => void;
  onPatch: (localId: string, p: Partial<EditRow>) => void;
  onSelectAll: (value: boolean) => void;
  onUpdateExisting: (v: boolean) => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("opErp");
  const allIncluded = rows.length > 0 && rows.every((r) => r.include);
  const hasExisting = rows.some((r) => r.matchedIngredientId);

  return (
    <>
      {/* Resumen + controles */}
      <div className="px-5 py-3 border-b border-op-border shrink-0 space-y-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 text-xs flex-wrap">
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-terracotta/10 text-terracotta font-medium">
              {t("impInvSummaryNew", { count: summary.newCount })}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-ok/10 text-ok font-medium">
              {t("impInvSummaryExisting", { count: summary.existingCount })}
            </span>
            <span className="text-op-muted">
              {t("impInvSummaryValued", { amount: money(summary.valued) })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSelectAll(true)}
              className="h-8 px-3 rounded-full border border-op-border text-xs hover:bg-op-bg"
            >
              {t("impInvSelectAll")}
            </button>
            <button
              type="button"
              onClick={() => onSelectAll(false)}
              className="h-8 px-3 rounded-full border border-op-border text-xs hover:bg-op-bg"
            >
              {t("impInvSelectNone")}
            </button>
          </div>
        </div>
        {notes && (
          <div className="text-[11px] text-op-muted">
            <span className="font-medium">{t("impInvNotesLabel")}: </span>
            {notes}
          </div>
        )}
      </div>

      {/* Tabla densa: header sticky + scroll vertical */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 z-10 bg-op-surface">
            <tr className="text-op-muted border-b border-op-border">
              <th className="p-1.5 w-8 text-center">
                <input
                  type="checkbox"
                  checked={allIncluded}
                  onChange={(e) => onSelectAll(e.target.checked)}
                  className="accent-terracotta w-3.5 h-3.5 align-middle"
                  aria-label={t("impInvSelectAll")}
                />
              </th>
              <th className="p-1.5 text-left font-mono text-[9px] tracking-wider uppercase">
                {t("impInvColStatus")}
              </th>
              <th className="p-1.5 text-left font-mono text-[9px] tracking-wider uppercase">
                {t("impInvColName")}
              </th>
              <th className="p-1.5 text-left font-mono text-[9px] tracking-wider uppercase">
                {t("impInvColMeasure")}
              </th>
              <th className="p-1.5 text-left font-mono text-[9px] tracking-wider uppercase">
                {t("impInvColCategory")}
              </th>
              <th className="p-1.5 text-right font-mono text-[9px] tracking-wider uppercase">
                {t("impInvColQty")}
              </th>
              <th className="p-1.5 text-left font-mono text-[9px] tracking-wider uppercase">
                {t("impInvColUnit")}
              </th>
              <th className="p-1.5 text-right font-mono text-[9px] tracking-wider uppercase">
                {t("impInvColCost")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <TableRow key={r.localId} row={r} onPatch={onPatch} />
            ))}
          </tbody>
        </table>
        {/* Datalist único compartido por el input de categoría de cada fila. */}
        <datalist id="imp-inv-categories">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>

      {/* Footer: re-procesar + updateExisting + confirmar */}
      <div className="border-t border-op-border p-4 space-y-3 shrink-0">
        <details className="text-xs">
          <summary className="cursor-pointer text-op-muted hover:text-ink select-none">
            {t("impInvReprocess")}
            {fileName && <span className="font-mono ml-2">{fileName}</span>}
          </summary>
          <div className="mt-2 space-y-2">
            <textarea
              value={instructions}
              onChange={(e) => onInstructions(e.target.value)}
              rows={2}
              maxLength={1000}
              placeholder={t("impInvInstructionsPlaceholder")}
              className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-xs focus:outline-none focus:border-op-text/40"
            />
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="text-[11px] text-terracotta">
                {t("impInvReprocessWarn")}
              </p>
              <button
                type="button"
                onClick={onReprocess}
                disabled={busy}
                className="h-9 px-4 rounded-full border border-op-border text-xs font-medium hover:bg-op-bg disabled:opacity-40 inline-flex items-center gap-1.5 shrink-0"
              >
                <span aria-hidden>{"↻"}</span>
                {t("impInvReprocess")}
              </button>
            </div>
          </div>
        </details>

        {hasExisting && (
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={updateExisting}
              onChange={(e) => onUpdateExisting(e.target.checked)}
              className="mt-0.5 accent-terracotta w-4 h-4 shrink-0"
            />
            <span className="text-xs">
              <span className="font-medium">{t("impInvUpdateExisting")}</span>
              <span className="block text-[11px] text-op-muted">
                {t("impInvUpdateExistingHint")}
              </span>
            </span>
          </label>
        )}

        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-op-muted">
            {t("impInvRowsIncluded", { count: summary.included })}
          </span>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || summary.included === 0}
            className="min-h-[44px] px-5 rounded-full bg-terracotta text-bone text-sm font-medium disabled:opacity-40"
          >
            {busy
              ? t("impInvConfirming")
              : t("impInvConfirmCount", { count: summary.included })}
          </button>
        </div>
      </div>
    </>
  );
}

function TableRow({
  row,
  onPatch,
}: {
  row: EditRow;
  onPatch: (localId: string, p: Partial<EditRow>) => void;
}) {
  const t = useTranslations("opErp");
  const existing = row.matchedIngredientId != null;
  const unitOptions = DISPLAY_UNITS[row.measureKind];
  const cellInput =
    "w-full min-h-[32px] px-1.5 rounded border border-transparent bg-transparent hover:border-op-border focus:border-op-text/40 focus:bg-op-bg focus:outline-none text-xs";

  return (
    <tr
      className={
        "border-b border-op-border last:border-b-0 " +
        (row.include ? "" : "opacity-40")
      }
    >
      <td className="p-1.5 text-center align-top">
        <input
          type="checkbox"
          checked={row.include}
          onChange={(e) => onPatch(row.localId, { include: e.target.checked })}
          className="accent-terracotta w-3.5 h-3.5 align-middle mt-1.5"
          aria-label={t("impInvColInclude")}
        />
      </td>
      <td className="p-1.5 align-top whitespace-nowrap">
        <span
          className={
            "inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium " +
            (existing
              ? "bg-ok/10 text-ok"
              : "bg-terracotta/10 text-terracotta")
          }
        >
          {existing ? t("impInvStatusExisting") : t("impInvStatusNew")}
        </span>
        {row.lowConfidence && (
          <span className="block mt-0.5 text-[9px] text-[#7F5A1F] bg-[#C98A2E]/15 px-1.5 py-0.5 rounded-full text-center">
            {t("impInvLowConfidence")}
          </span>
        )}
      </td>
      <td className="p-1.5 align-top min-w-[160px]">
        <input
          value={row.name}
          onChange={(e) => onPatch(row.localId, { name: e.target.value })}
          placeholder={t("impInvNamePlaceholder")}
          maxLength={120}
          className={cellInput + " font-medium"}
        />
        {row.presentationNote && (
          <span
            className="block px-1.5 text-[10px] text-op-muted truncate"
            title={row.presentationNote}
          >
            {row.presentationNote}
          </span>
        )}
      </td>
      <td className="p-1.5 align-top">
        <select
          value={row.measureKind}
          onChange={(e) =>
            onPatch(row.localId, { measureKind: e.target.value as MeasureKind })
          }
          className="min-h-[32px] px-1 rounded border border-op-border bg-op-bg text-xs"
        >
          {MEASURE_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(DIM_LABEL_KEYS[k])}
            </option>
          ))}
        </select>
      </td>
      <td className="p-1.5 align-top min-w-[120px]">
        <input
          value={row.category}
          onChange={(e) => onPatch(row.localId, { category: e.target.value })}
          list="imp-inv-categories"
          maxLength={60}
          className={cellInput}
        />
      </td>
      <td className="p-1.5 align-top w-[76px]">
        <input
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={row.qty}
          onChange={(e) => onPatch(row.localId, { qty: e.target.value })}
          className={cellInput + " text-right tabular"}
        />
      </td>
      <td className="p-1.5 align-top w-[64px]">
        <select
          value={row.unit}
          onChange={(e) => onPatch(row.localId, { unit: e.target.value })}
          disabled={unitOptions.length < 2}
          className="min-h-[32px] w-full px-1 rounded border border-op-border bg-op-bg text-xs disabled:opacity-50"
        >
          {unitOptions.map((u) => (
            <option key={u.symbol} value={u.symbol}>
              {u.symbol}
            </option>
          ))}
        </select>
      </td>
      <td className="p-1.5 align-top w-[96px]">
        <div className="flex items-center gap-0.5">
          <span className="text-op-muted text-[11px]" aria-hidden>
            {"$"}
          </span>
          <input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={row.cost}
            onChange={(e) => onPatch(row.localId, { cost: e.target.value })}
            className={cellInput + " text-right tabular"}
          />
        </div>
      </td>
    </tr>
  );
}
