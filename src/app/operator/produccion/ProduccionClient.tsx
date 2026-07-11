"use client";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { grossQty } from "@/lib/erp/recipes";
import {
  BASE_UNIT_SYMBOL,
  DISPLAY_UNITS,
  formatBaseQty,
  toBaseQty,
  type MeasureKind,
} from "@/lib/erp/units";

/* ───────────────────────────── Tipos ───────────────────────────────── */
// Espejo de GET /api/operator/production (historial) + los pedazos de
// GET /recipes (sub-recetas producibles) y GET /stock (promedio actual)
// que alimentan el picker y el preview — spec A5·D4: el preview se
// calcula EN EL CLIENTE con datos que ya existen, cero endpoints nuevos.

type BatchMovementDto = {
  ingredientId: string;
  /** Salida del ledger (production_out): NEGATIVO — se muestra absoluto. */
  qtyBase: number;
  /** Negativo (salida); 0 = línea sin costo. Se muestra absoluto. */
  valueCents: number;
  ingredient: { name: string; measureKind: MeasureKind };
};

type BatchDto = {
  id: string;
  outputQtyBase: number;
  costCents: number;
  note: string | null;
  createdAt: string;
  outputIngredient: { id: string; name: string; measureKind: MeasureKind };
  createdBy: { id: string; name: string } | null;
  movements: BatchMovementDto[];
  partialCost: boolean;
};

type SubRecipeDto = {
  ingredientId: string;
  ingredientName: string;
  measureKind: MeasureKind;
  /** Rendimiento del batch en unidad base ("rinde 2000 ml"). */
  outputQtyBase: number | null;
  items: Array<{
    ingredientId: string;
    ingredientName: string;
    measureKind: MeasureKind;
    /** Neto por rendimiento; el bruto (merma) se deriva con grossQty. */
    qtyBase: number;
    wastePct: number;
  }>;
};

type StockRowDto = {
  id: string;
  name: string;
  measureKind: MeasureKind;
  stockLevel: { qtyBase: number; totalValueCents: number } | null;
};

/* ─────────────────────────── Helpers ───────────────────────────────── */

/** Búsqueda sin acentos: minúsculas + tildes fuera ("azucar" → "azúcar"). */
function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** "g/kg", "ml/L", "un" — símbolos de unidad, iguales en es/en/pt. */
function unitSymbols(kind: MeasureKind): string {
  return DISPLAY_UNITS[kind].map((u) => u.symbol).join("/");
}

/** 2500 g → { qty: "2.5", unit: "kg" } — para precargar inputs de cantidad. */
function baseToInputQty(
  base: number,
  kind: MeasureKind,
): { qty: string; unit: string } {
  const units = DISPLAY_UNITS[kind];
  const big = units[units.length - 1];
  if (big.factor > 1 && base >= big.factor) {
    return { qty: String(base / big.factor), unit: big.symbol };
  }
  // units[0].factor: 1 para g/ml, 1000 para count "un" (base milesimal).
  return { qty: String(base / units[0].factor), unit: units[0].symbol };
}

// Errores del POST de producción → clave i18n (fallback errSaveFailed).
const API_ERROR_KEYS: Record<string, string> = {
  invalid: "productionErrQtyInvalid",
  qty_invalid: "productionErrQtyInvalid",
  no_subrecipe: "productionErrNoSubRecipe",
  ingredient_not_found: "errIngredientNotFound",
};

/* ───────────────────────────── Lista ───────────────────────────────── */

export function ProduccionClient({ currency }: { currency: string }) {
  const t = useTranslations("opErp");

  // null = historial invalidado (carga inicial o batch nuevo) → refetch.
  const [batches, setBatches] = useState<BatchDto[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [subs, setSubs] = useState<SubRecipeDto[]>([]);
  const [stock, setStock] = useState<StockRowDto[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [produceOpen, setProduceOpen] = useState(false);

  useEffect(() => {
    if (batches !== null || loadErr) return;
    let cancelled = false;
    (async () => {
      try {
        // Historial + datos del sheet en paralelo. Se refresca TODO tras
        // cada batch: producir mueve existencias y promedios, y el preview
        // del próximo batch debe costear con el inventario ya movido.
        const [rb, rr, rs] = await Promise.all([
          fetch("/api/operator/production"),
          fetch("/api/operator/recipes"),
          fetch("/api/operator/stock"),
        ]);
        if (!rb.ok || !rr.ok || !rs.ok) throw new Error("load_failed");
        const [jb, jr, js] = await Promise.all([
          rb.json(),
          rr.json(),
          rs.json(),
        ]);
        if (cancelled) return;
        setBatches((jb.batches ?? []) as BatchDto[]);
        setNextCursor(jb.nextCursor ?? null);
        setSubs((jr.subRecipes ?? []) as SubRecipeDto[]);
        setStock((js.stock ?? []) as StockRowDto[]);
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [batches, loadErr]);

  function invalidate() {
    setBatches(null);
    setNextCursor(null);
    setLoadErr(false);
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(
        `/api/operator/production?cursor=${encodeURIComponent(nextCursor)}`,
      );
      if (!r.ok) throw new Error("load_failed");
      const j = await r.json();
      setBatches((prev) => [
        ...(prev ?? []),
        ...((j.batches ?? []) as BatchDto[]),
      ]);
      setNextCursor(j.nextCursor ?? null);
    } catch {
      setLoadErr(true);
    }
    setLoadingMore(false);
  }

  // Promedio actual por insumo para el preview (avg = valor/cantidad).
  const stockById = useMemo(() => {
    const m = new Map<string, StockRowDto>();
    for (const s of stock) m.set(s.id, s);
    return m;
  }, [stock]);

  // Solo sub-recetas con rendimiento y líneas: sin rendimiento no hay
  // factor de escala (el server respondería no_subrecipe).
  const producibleSubs = useMemo(
    () =>
      subs.filter(
        (s) =>
          s.outputQtyBase != null &&
          s.outputQtyBase > 0 &&
          s.items.length > 0,
      ),
    [subs],
  );

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => setProduceOpen(true)}
        className="w-full min-h-[44px] rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
      >
        {t("productionProduceButton")}
      </button>

      {loadErr ? (
        <div className="text-xs text-danger">{t("errLoadFailed")}</div>
      ) : batches === null ? (
        <div className="py-6 text-center text-sm text-op-muted">
          {t("loading")}
        </div>
      ) : batches.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
          <div className="font-display text-lg mb-1">
            {t("productionEmptyTitle")}
          </div>
          <p className="text-sm text-op-muted">{t("productionEmptyBody")}</p>
        </div>
      ) : (
        <>
          <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
            {batches.map((b) => (
              <BatchRow
                key={b.id}
                batch={b}
                currency={currency}
                expanded={expandedId === b.id}
                onToggle={() =>
                  setExpandedId((cur) => (cur === b.id ? null : b.id))
                }
              />
            ))}
          </div>
          {nextCursor && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full min-h-[44px] rounded-full border border-op-border bg-op-surface text-sm font-medium hover:bg-op-bg disabled:opacity-40"
            >
              {loadingMore ? t("loading") : t("loadMore")}
            </button>
          )}
        </>
      )}

      {produceOpen && (
        <ProduceSheet
          subs={producibleSubs}
          stockById={stockById}
          currency={currency}
          onClose={() => setProduceOpen(false)}
          onCreated={() => {
            setProduceOpen(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

/* ─────────────────────── Fila de batch ─────────────────────────────── */

// Fila del historial: elaborado + cantidad, costo, fecha y quién; badge
// ámbar cuando el batch entró con costo parcial (alguna salida en $0).
// Tap → expande las salidas (absolutas — el ledger las guarda negativas)
// y la nota.
function BatchRow({
  batch,
  currency,
  expanded,
  onToggle,
}: {
  batch: BatchDto;
  currency: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  return (
    <div className="border-b border-op-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full text-left px-4 py-2.5 hover:bg-op-bg"
      >
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium truncate">
                {batch.outputIngredient.name}
              </span>
              <span className="text-sm text-op-muted tabular-nums shrink-0">
                {formatBaseQty(
                  batch.outputQtyBase,
                  batch.outputIngredient.measureKind,
                  locale,
                )}
              </span>
              {batch.partialCost && (
                <span className="px-2 h-5 inline-flex items-center rounded-full bg-[#C98A2E]/15 text-[#7F5A1F] text-[10px] font-medium shrink-0">
                  {t("batchPartialCostBadge")}
                </span>
              )}
            </div>
            <div className="text-[11px] text-op-muted mt-0.5 truncate">
              {[formatDate(batch.createdAt, { locale }), batch.createdBy?.name]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-sm font-medium tabular-nums">
              {formatMoney(batch.costCents, { currency, locale })}
            </div>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3">
          <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
            {t("batchOutputsTitle")}
          </div>
          <div className="rounded-xl border border-op-border overflow-hidden">
            {batch.movements.map((m, i) => (
              <div
                key={`${m.ingredientId}-${i}`}
                className="px-3 py-2 border-b border-op-border last:border-b-0 flex items-center justify-between gap-3"
              >
                <span className="text-sm truncate">{m.ingredient.name}</span>
                <span className="text-xs text-op-muted tabular-nums shrink-0">
                  {`${formatBaseQty(
                    Math.abs(m.qtyBase),
                    m.ingredient.measureKind,
                    locale,
                  )} · ${
                    m.valueCents === 0
                      ? t("noCostBadge")
                      : formatMoney(Math.abs(m.valueCents), {
                          currency,
                          locale,
                        })
                  }`}
                </span>
              </div>
            ))}
          </div>
          {batch.note && (
            <p className="text-[11px] text-op-muted mt-2">{batch.note}</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────── Sheet "Producir" (crear batch) ────────────────── */

function ProduceSheet({
  subs,
  stockById,
  currency,
  onClose,
  onCreated,
}: {
  /** Sub-recetas producibles (con rendimiento y líneas). */
  subs: SubRecipeDto[];
  stockById: Map<string, StockRowDto>;
  currency: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  const [selected, setSelected] = useState<SubRecipeDto | null>(null);
  const [subQ, setSubQ] = useState("");
  const [qtyRaw, setQtyRaw] = useState("");
  const [qtyUnit, setQtyUnit] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const matches = useMemo(() => {
    const needle = fold(subQ.trim());
    return subs
      .filter((s) => !needle || fold(s.ingredientName).includes(needle))
      .slice(0, 8);
  }, [subs, subQ]);

  function pick(s: SubRecipeDto) {
    setErr(null);
    setSelected(s);
    // Default = rendimiento de la sub-receta, en unidad display legible.
    const init =
      s.outputQtyBase != null
        ? baseToInputQty(s.outputQtyBase, s.measureKind)
        : { qty: "", unit: BASE_UNIT_SYMBOL[s.measureKind] };
    setQtyRaw(init.qty);
    setQtyUnit(init.unit);
    setSubQ("");
  }

  // Cantidad producida en unidad base (toBaseQty rechaza pérdidas de
  // precisión tipo 0,0004 kg — mismo manejo que las líneas de receta).
  const producedBase = selected
    ? toBaseQty(Number(qtyRaw.replace(",", ".")), selected.measureKind, qtyUnit)
    : null;
  const yieldBase = selected?.outputQtyBase ?? null;

  // Preview EN VIVO — misma matemática del server (scaleBatchLines):
  // factor = producido/rendimiento; consumo por línea = round(grossQty
  // (neto, merma) × factor), líneas que escalan a 0 fuera. Valor al
  // promedio ACTUAL del inventario (valor/cantidad si hay existencia
  // positiva, si no 0 → línea sin costo ⇒ batch con costo parcial). La
  // verdad sigue siendo del server: acá solo se anticipa el resultado.
  const preview = useMemo(() => {
    if (!selected || yieldBase == null || producedBase == null) return null;
    const factor = producedBase / yieldBase;
    const lines = selected.items
      .map((it) => {
        const consumedBase = Math.round(
          grossQty(it.qtyBase, it.wastePct) * factor,
        );
        const level = stockById.get(it.ingredientId)?.stockLevel ?? null;
        const avg =
          level && level.qtyBase > 0
            ? level.totalValueCents / level.qtyBase
            : 0;
        return {
          ingredientId: it.ingredientId,
          name: it.ingredientName,
          measureKind: it.measureKind,
          consumedBase,
          stockQtyBase: level?.qtyBase ?? 0,
          valueCents: Math.round(consumedBase * avg),
          noCost: avg === 0,
        };
      })
      .filter((l) => l.consumedBase > 0);
    const totalCents = lines.reduce((sum, l) => sum + l.valueCents, 0);
    return { lines, totalCents, partial: lines.some((l) => l.noCost) };
  }, [selected, yieldBase, producedBase, stockById]);

  async function submit() {
    if (!selected) return;
    setErr(null);
    if (producedBase == null) {
      setErr(t("productionErrQtyInvalid"));
      return;
    }
    setBusy(true);
    const r = await fetch("/api/operator/production", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        outputIngredientId: selected.ingredientId,
        outputQtyBase: producedBase,
        note: note.trim() || null,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = API_ERROR_KEYS[j.error as string];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    // 201: el historial se refetchea completo (trae el batch con sus
    // salidas y el flag de costo parcial calculados por el server).
    onCreated();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[92dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="font-display text-2xl truncate">
            {t("productionSheetTitle")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>

        <div className="space-y-3">
          {/* Picker de sub-receta (las de A3, con rendimiento) */}
          {subs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-op-border bg-op-bg/50 p-6 text-center text-sm text-op-muted">
              {t("productionNoSubRecipes")}
            </div>
          ) : selected === null ? (
            <div className="rounded-2xl border border-op-border bg-op-bg/50 p-4 space-y-2">
              <Field
                label={t("productionSubRecipeLabel")}
                hint={t("productionSubRecipeHint")}
              >
                <input
                  type="search"
                  value={subQ}
                  onChange={(e) => setSubQ(e.target.value)}
                  placeholder={t("productionSearchPlaceholder")}
                  className={inputCls}
                />
              </Field>
              <div className="rounded-lg border border-op-border bg-op-surface overflow-hidden max-h-44 overflow-y-auto">
                {matches.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-op-muted">
                    {t("productionNoMatches")}
                  </div>
                ) : (
                  matches.map((s) => (
                    <button
                      key={s.ingredientId}
                      type="button"
                      onClick={() => pick(s)}
                      className="w-full min-h-[40px] px-3 py-1.5 text-left text-sm hover:bg-op-bg border-b border-op-border last:border-b-0 flex items-center justify-between gap-2"
                    >
                      <span className="truncate">
                        <span>{s.ingredientName}</span>
                        <span className="font-mono text-[10px] text-op-muted ml-2">
                          {unitSymbols(s.measureKind)}
                        </span>
                      </span>
                      <span className="text-[10px] text-op-muted tabular-nums shrink-0">
                        {s.outputQtyBase != null
                          ? t("subRecipeYieldLabel", {
                              qty: formatBaseQty(
                                s.outputQtyBase,
                                s.measureKind,
                                locale,
                              ),
                            })
                          : "—"}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-op-border bg-op-bg/50 px-4 py-3 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                  {t("productionSubRecipeLabel")}
                </div>
                <div className="text-sm font-medium truncate">
                  {selected.ingredientName}
                  <span className="font-mono text-[10px] text-op-muted ml-2">
                    {unitSymbols(selected.measureKind)}
                  </span>
                </div>
                {yieldBase != null && (
                  <div className="text-[11px] text-op-muted mt-0.5 tabular-nums">
                    {t("subRecipeYieldLabel", {
                      qty: formatBaseQty(yieldBase, selected.measureKind, locale),
                    })}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setErr(null);
                  setSelected(null);
                  setQtyRaw("");
                }}
                className="min-h-[44px] px-3 rounded-full text-[11px] font-medium text-op-muted hover:bg-op-bg shrink-0"
              >
                {t("changeIngredient")}
              </button>
            </div>
          )}

          {selected && (
            <>
              {/* Cantidad producida (libre — batch y medio cuenta) */}
              <Field
                label={t("productionQtyField")}
                required
                hint={t("productionQtyHint")}
              >
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step="any"
                    inputMode="decimal"
                    value={qtyRaw}
                    onChange={(e) => {
                      setErr(null);
                      setQtyRaw(e.target.value);
                    }}
                    className={inputCls + " flex-1 min-w-0"}
                  />
                  <select
                    value={qtyUnit}
                    onChange={(e) => setQtyUnit(e.target.value)}
                    disabled={DISPLAY_UNITS[selected.measureKind].length < 2}
                    aria-label={t("fieldQty")}
                    className="min-h-[44px] w-20 px-2 rounded-lg border border-op-border bg-op-bg text-sm disabled:opacity-40"
                  >
                    {DISPLAY_UNITS[selected.measureKind].map((u) => (
                      <option key={u.symbol} value={u.symbol}>
                        {u.symbol}
                      </option>
                    ))}
                  </select>
                </div>
              </Field>

              {/* Preview EN VIVO de consumos escalados */}
              {preview && preview.lines.length > 0 && (
                <div>
                  <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
                    {t("productionPreviewTitle")}
                  </div>
                  <div className="rounded-2xl border border-op-border overflow-hidden">
                    {preview.lines.map((l) => (
                      <div
                        key={l.ingredientId}
                        className="px-3 py-2 border-b border-op-border last:border-b-0"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-medium truncate">
                            {l.name}
                          </span>
                          <span className="text-xs font-medium tabular-nums shrink-0">
                            {l.noCost
                              ? "—"
                              : formatMoney(l.valueCents, { currency, locale })}
                          </span>
                        </div>
                        {/* Consumo escalado + existencia actual (referencia:
                            el stock puede quedar negativo, nunca bloquea) */}
                        <div className="text-[11px] text-op-muted mt-0.5 tabular-nums">
                          {`${formatBaseQty(
                            l.consumedBase,
                            l.measureKind,
                            locale,
                          )} · ${t("currentStockLabel")}: ${formatBaseQty(
                            l.stockQtyBase,
                            l.measureKind,
                            locale,
                          )}`}
                        </div>
                        {l.noCost && (
                          <div className="text-[10px] text-op-muted mt-0.5">
                            {t("productionLineNoCostHint")}
                          </div>
                        )}
                      </div>
                    ))}
                    <div className="px-3 py-2 bg-op-bg/50 flex items-center justify-between gap-3">
                      <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
                        {t("productionEstimatedTotalLabel")}
                      </span>
                      <span className="text-sm font-medium tabular-nums flex items-center gap-2">
                        {preview.partial && (
                          <span className="px-2 h-5 inline-flex items-center rounded-full bg-[#C98A2E]/15 text-[#7F5A1F] text-[10px] font-medium">
                            {t("batchPartialCostBadge")}
                          </span>
                        )}
                        {formatMoney(preview.totalCents, { currency, locale })}
                      </span>
                    </div>
                  </div>
                  {preview.partial && (
                    <p className="text-[10px] text-[#7F5A1F] mt-1">
                      {t("productionPartialHint")}
                    </p>
                  )}
                </div>
              )}

              <Field label={t("fieldNotes")}>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={500}
                  rows={2}
                  className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40"
                />
              </Field>
            </>
          )}

          {err && <div className="text-xs text-danger">{err}</div>}

          <div className="flex items-center gap-3 pt-1">
            <div className="flex-1" />
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={busy || !selected}
              className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
            >
              {busy ? t("productionSubmitting") : t("productionSubmit")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── UI compartida ──────────────────────── */

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1">
        {label}
        {required && <span className="text-danger ml-1">{"*"}</span>}
      </div>
      {children}
      {hint && <div className="text-[10px] text-op-muted mt-1">{hint}</div>}
    </label>
  );
}

const inputCls =
  "w-full min-h-[44px] px-3 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40";
