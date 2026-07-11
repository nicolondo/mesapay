"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney, pesosToCents } from "@/lib/format";
import { MoneyInput } from "@/components/MoneyInput";
import {
  BASE_UNIT_SYMBOL,
  DISPLAY_UNITS,
  formatBaseQty,
  toBaseQty,
  type MeasureKind,
} from "@/lib/erp/units";

type StockLevel = {
  qtyBase: number;
  totalValueCents: number;
  updatedAt: string | Date;
};

type StockRow = {
  id: string;
  name: string;
  category: string | null;
  measureKind: MeasureKind;
  active: boolean;
  // A4 — punto de reorden (null = sin aviso) y cantidad sugerida de compra.
  reorderPointBase: number | null;
  reorderQtyBase: number | null;
  stockLevel: StockLevel | null;
};

/**
 * "Bajo mínimo" (spec A4·D3): existencia actual ≤ punto de reorden,
 * negativos incluidos; sin nivel de stock cuenta como 0. Insumos sin
 * punto de reorden nunca alertan, y los inactivos tampoco — no tiene
 * sentido pedir un insumo descatalogado.
 */
function isLowStock(r: StockRow): boolean {
  return (
    r.active &&
    r.reorderPointBase != null &&
    (r.stockLevel?.qtyBase ?? 0) <= r.reorderPointBase
  );
}

type MovementRow = {
  id: string;
  kind: string;
  qtyBase: number;
  valueCents: number;
  wasteReason: string | null;
  note: string | null;
  createdAt: string;
  ingredient: { id: string; name: string; measureKind: MeasureKind };
  createdBy: { id: string; name: string | null } | null;
};

// ── Conteos (spec D5): sesión borrador → cierre con ajustes ──
type CountSummary = {
  id: string;
  status: "draft" | "closed";
  notes: string | null;
  createdAt: string;
  closedAt: string | null;
  createdBy: { name: string | null } | null;
  _count: { items: number };
};

type CountItemRow = {
  id: string;
  expectedQty: number;
  countedQty: number | null;
  ingredient: {
    id: string;
    name: string;
    measureKind: MeasureKind;
    category: string | null;
    active: boolean;
  };
};

type CountDetail = Omit<CountSummary, "_count"> & { items: CountItemRow[] };

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

// Claves i18n por kind de movimiento — resueltas con t() al render.
// A1 solo genera los 4 manuales; count_adjust llega con los conteos (A1.4)
// y ya queda cubierto. Kinds futuros (A4/A5) caen al código crudo.
const KIND_LABEL_KEYS: Record<string, string> = {
  purchase_in: "kindPurchaseIn",
  adjust_in: "kindAdjustIn",
  adjust_out: "kindAdjustOut",
  waste: "kindWaste",
  count_adjust: "kindCountAdjust",
  // A4 — consumo automático por venta (lo escribe el server al pagar una
  // orden; acá solo se lee).
  sale_consumption: "kindSaleConsumption",
  // A5 — producción de lotes (los escribe /operator/produccion).
  production_in: "kindProductionIn",
  production_out: "kindProductionOut",
};

const WASTE_REASONS = [
  "expired",
  "damaged",
  "kitchen_error",
  "spill",
  "other",
] as const;
type WasteReason = (typeof WASTE_REASONS)[number];

const WASTE_REASON_KEYS: Record<string, string> = {
  expired: "wasteExpired",
  damaged: "wasteDamaged",
  kitchen_error: "wasteKitchenError",
  spill: "wasteSpill",
  other: "wasteOther",
};

// Errores de la API de movimientos → clave i18n (fallback errSaveFailed).
const API_ERROR_KEYS: Record<string, string> = {
  qty_invalid: "errContentInvalid",
  cost_invalid: "errCostInvalid",
  ingredient_inactive: "errIngredientInactive",
  ingredient_not_found: "errIngredientNotFound",
};

type Tab = "stock" | "movements" | "counts";
type SheetMode = "entry" | "adjust" | "waste";

export function InventarioClient({
  initial,
  currency,
}: {
  initial: StockRow[];
  currency: string;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [rows, setRows] = useState<StockRow[]>(initial);
  const [tab, setTab] = useState<Tab>("stock");
  // Ajustes de categorías sin inventario — sheet propio (carga perezosa).
  const [invSettingsOpen, setInvSettingsOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");
  // Filtro "bajo mínimo" (A4·D3) — lo activan el chip y el banner contador.
  const [lowOnly, setLowOnly] = useState(false);
  const [sheet, setSheet] = useState<SheetMode | null>(null);

  // Historial — se carga perezoso al abrir el tab; null = sin cargar (un
  // movimiento nuevo lo resetea a null para forzar refetch fresco).
  const [movements, setMovements] = useState<MovementRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [movErr, setMovErr] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Conteos — mismo patrón perezoso que el historial.
  const [counts, setCounts] = useState<CountSummary[] | null>(null);
  const [countsErr, setCountsErr] = useState(false);
  const [newCountOpen, setNewCountOpen] = useState(false);
  const [openCount, setOpenCount] = useState<CountDetail | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.category) set.add(r.category);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = fold(q.trim());
    return rows.filter((r) => {
      if (lowOnly && !isLowStock(r)) return false;
      if (cat !== "all" && r.category !== cat) return false;
      if (needle) {
        const hay = fold(`${r.name} ${r.category ?? ""}`);
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [rows, q, cat, lowOnly]);

  const lowCount = useMemo(() => rows.filter(isLowStock).length, [rows]);

  const activeIngredients = useMemo(
    () => rows.filter((r) => r.active),
    [rows],
  );

  useEffect(() => {
    if (tab !== "movements" || movements !== null || movErr) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/stock/movements");
        if (!r.ok) throw new Error("load_failed");
        const j = await r.json();
        if (cancelled) return;
        setMovements((j.movements ?? []) as MovementRow[]);
        setNextCursor(j.nextCursor ?? null);
      } catch {
        if (!cancelled) setMovErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, movements, movErr]);

  useEffect(() => {
    if (tab !== "counts" || counts !== null || countsErr) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/stock/counts");
        if (!r.ok) throw new Error("load_failed");
        const j = await r.json();
        if (!cancelled) setCounts((j.counts ?? []) as CountSummary[]);
      } catch {
        if (!cancelled) setCountsErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, counts, countsErr]);

  async function openSession(id: string) {
    if (openingId) return;
    setOpeningId(id);
    try {
      const r = await fetch(`/api/operator/stock/counts/${id}`);
      if (!r.ok) throw new Error("load_failed");
      const j = await r.json();
      setOpenCount(j.count as CountDetail);
    } catch {
      setCountsErr(true);
    }
    setOpeningId(null);
  }

  // Cierre de conteo: los ajustes tocan N saldos a la vez → se refrescan
  // las existencias completas desde el server y se invalidan historial y
  // lista de sesiones (misma filosofía que handleMovementDone).
  async function handleCountClosed() {
    setCounts(null);
    setCountsErr(false);
    setMovements(null);
    setNextCursor(null);
    setMovErr(false);
    try {
      const r = await fetch("/api/operator/stock");
      if (r.ok) {
        const j = await r.json();
        setRows((j.stock ?? []) as StockRow[]);
      }
    } catch {
      // Silencioso: el saldo se refresca al próximo load de la página.
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await fetch(
        `/api/operator/stock/movements?cursor=${encodeURIComponent(nextCursor)}`,
      );
      if (!r.ok) throw new Error("load_failed");
      const j = await r.json();
      setMovements((prev) => [
        ...(prev ?? []),
        ...((j.movements ?? []) as MovementRow[]),
      ]);
      setNextCursor(j.nextCursor ?? null);
    } catch {
      setMovErr(true);
    }
    setLoadingMore(false);
  }

  // Movimiento registrado: el saldo del row viene del server (fuente de
  // verdad) y el historial cargado queda stale → se invalida para refetch.
  function handleMovementDone(ingredientId: string, level: StockLevel) {
    setRows((prev) =>
      prev.map((r) => (r.id === ingredientId ? { ...r, stockLevel: level } : r)),
    );
    setMovements(null);
    setNextCursor(null);
    setMovErr(false);
    setSheet(null);
  }

  return (
    <div className="space-y-4">
      {/* Segmentos Existencias / Movimientos / Conteos + acceso a ajustes */}
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-full border border-op-border bg-op-surface overflow-hidden">
          {(
            [
              ["stock", t("tabStock")],
              ["movements", t("tabMovements")],
              ["counts", t("tabCounts")],
            ] as [Tab, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={
                "min-h-[44px] px-5 text-xs font-medium transition-colors " +
                (tab === value
                  ? "bg-ink text-bone"
                  : "text-op-muted hover:text-ink")
              }
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setInvSettingsOpen(true)}
          aria-label={t("invSettingsTitle")}
          title={t("invSettingsTitle")}
          className="min-h-[44px] min-w-[44px] rounded-full border border-op-border bg-op-surface text-base text-op-muted hover:text-ink hover:bg-op-bg shrink-0"
        >
          {"⚙"}
        </button>
      </div>

      {tab === "stock" ? (
        <>
          {/* Acciones — abren sheets con combobox de insumo */}
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setSheet("entry")}
              className="min-h-[44px] rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
            >
              {t("actionEntry")}
            </button>
            <button
              type="button"
              onClick={() => setSheet("adjust")}
              className="min-h-[44px] rounded-full border border-op-border bg-op-surface text-sm font-medium hover:bg-op-bg"
            >
              {t("actionAdjust")}
            </button>
            <button
              type="button"
              onClick={() => setSheet("waste")}
              className="min-h-[44px] rounded-full border border-op-border bg-op-surface text-sm font-medium hover:bg-op-bg"
            >
              {t("actionWaste")}
            </button>
          </div>

          {/* Aviso bajo mínimo (A4·D3): contador que aplica el filtro */}
          {lowCount > 0 && (
            <button
              type="button"
              onClick={() => setLowOnly(true)}
              className="w-full text-left rounded-2xl border border-[#C98A2E]/40 bg-[#C98A2E]/10 px-4 py-3 text-sm font-medium text-[#7F5A1F] hover:bg-[#C98A2E]/15"
            >
              {t("reorderBannerCount", { count: lowCount })}
            </button>
          )}

          {/* Búsqueda + filtros (categoría · bajo mínimo) */}
          <div className="space-y-2">
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="w-full min-h-[44px] px-4 rounded-full border border-op-border bg-op-surface text-sm focus:outline-none focus:border-op-text/40"
            />
            <div className="flex items-center gap-2 flex-wrap">
              {categories.length > 0 && (
                <select
                  value={cat}
                  onChange={(e) => setCat(e.target.value)}
                  className="min-h-[44px] px-3 rounded-full border border-op-border bg-op-surface text-sm max-w-[220px]"
                >
                  <option value="all">{t("allCategories")}</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={() => setLowOnly((v) => !v)}
                aria-pressed={lowOnly}
                className={
                  "min-h-[44px] px-4 rounded-full border text-xs font-medium transition-colors " +
                  (lowOnly
                    ? "border-ink bg-ink text-bone"
                    : "border-op-border bg-op-surface text-op-muted hover:text-ink")
                }
              >
                {t("reorderLowBadge")}
              </button>
            </div>
          </div>

          {/* Existencias */}
          {rows.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center">
              <div className="font-display text-lg mb-1">
                {t("emptyStockTitle")}
              </div>
              <p className="text-sm text-op-muted">{t("emptyStockBody")}</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
              {t("emptyFiltered")}
            </div>
          ) : (
            <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
              {filtered.map((r) => {
                const qty = r.stockLevel?.qtyBase ?? 0;
                const value = r.stockLevel?.totalValueCents ?? 0;
                // Promedio derivado (spec D3) — solo con saldo positivo.
                const avg = qty > 0 ? Math.round(value / qty) : null;
                const low = isLowStock(r);
                return (
                  <div
                    key={r.id}
                    className="flex items-center gap-3 px-4 py-2.5 border-b border-op-border last:border-b-0"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={
                            "text-sm font-medium truncate" +
                            (r.active ? "" : " opacity-50")
                          }
                        >
                          {r.name}
                        </span>
                        {!r.active && (
                          <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
                            {t("inactiveBadge")}
                          </span>
                        )}
                        {low && (
                          <span className="px-2 h-5 inline-flex items-center rounded-full bg-[#C98A2E]/15 text-[#7F5A1F] text-[10px] font-medium shrink-0">
                            {t("reorderLowBadge")}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-op-muted mt-0.5 truncate">
                        {[
                          r.category ?? t("noCategory"),
                          // Referencia del umbral ("mín. 2 kg") en filas
                          // bajo mínimo, para leer el aviso sin abrir nada.
                          low && r.reorderPointBase != null
                            ? t("reorderMinRef", {
                                qty: formatBaseQty(
                                  r.reorderPointBase,
                                  r.measureKind,
                                  locale,
                                ),
                              })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div
                        className={
                          "text-sm font-medium tabular-nums" +
                          (qty < 0 ? " text-danger" : "")
                        }
                      >
                        {formatBaseQty(qty, r.measureKind, locale)}
                      </div>
                      <div className="text-[11px] text-op-muted mt-0.5 tabular-nums">
                        {[
                          formatMoney(value, { currency, locale }),
                          avg != null
                            ? `${formatMoney(avg, { currency, locale })}/${BASE_UNIT_SYMBOL[r.measureKind]}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : tab === "movements" ? (
        /* Movimientos */
        <>
          {movErr ? (
            <div className="text-xs text-danger">{t("errLoadFailed")}</div>
          ) : movements === null ? (
            <div className="py-6 text-center text-sm text-op-muted">
              {t("loading")}
            </div>
          ) : movements.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
              {t("movementsEmpty")}
            </div>
          ) : (
            <>
              <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
                {movements.map((m) => {
                  const isIn = m.qtyBase >= 0;
                  const labelKey = KIND_LABEL_KEYS[m.kind];
                  const reasonKey = m.wasteReason
                    ? WASTE_REASON_KEYS[m.wasteReason]
                    : null;
                  const kindLabel =
                    (labelKey ? t(labelKey) : m.kind) +
                    (reasonKey ? ` · ${t(reasonKey)}` : "");
                  return (
                    <div
                      key={m.id}
                      className="px-4 py-2.5 border-b border-op-border last:border-b-0"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">
                            {m.ingredient.name}
                          </div>
                          <div className="text-[11px] text-op-muted mt-0.5 truncate">
                            {[
                              formatDate(m.createdAt, { locale }),
                              kindLabel,
                              m.createdBy?.name ?? null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div
                            className={
                              "text-sm font-medium tabular-nums " +
                              (isIn ? "text-ok" : "text-danger")
                            }
                          >
                            {(isIn ? "+" : "−") +
                              formatBaseQty(
                                Math.abs(m.qtyBase),
                                m.ingredient.measureKind,
                                locale,
                              )}
                          </div>
                          <div className="text-[11px] text-op-muted mt-0.5 tabular-nums">
                            {(m.valueCents >= 0 ? "+" : "−") +
                              formatMoney(Math.abs(m.valueCents), {
                                currency,
                                locale,
                              })}
                          </div>
                        </div>
                      </div>
                      {m.note && (
                        <div className="text-[11px] text-op-muted mt-1">
                          {m.note}
                        </div>
                      )}
                    </div>
                  );
                })}
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
        </>
      ) : (
        /* Conteos físicos (sesiones borrador → cierre) */
        <>
          <button
            type="button"
            onClick={() => setNewCountOpen(true)}
            className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium hover:bg-ink/90"
          >
            {t("newCount")}
          </button>

          {countsErr ? (
            <div className="text-xs text-danger">{t("errLoadFailed")}</div>
          ) : counts === null ? (
            <div className="py-6 text-center text-sm text-op-muted">
              {t("loading")}
            </div>
          ) : counts.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-op-border bg-op-surface/50 p-8 text-center text-sm text-op-muted">
              {t("countsEmpty")}
            </div>
          ) : (
            <div className="bg-op-surface border border-op-border rounded-2xl overflow-hidden">
              {counts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => openSession(c.id)}
                  disabled={openingId !== null}
                  className="w-full text-left px-4 py-2.5 border-b border-op-border last:border-b-0 hover:bg-op-bg disabled:opacity-60"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium">
                          {formatDate(c.createdAt, { locale })}
                        </span>
                        <span
                          className={
                            "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium shrink-0 " +
                            (c.status === "draft"
                              ? "bg-ink text-bone"
                              : "bg-paper text-op-muted")
                          }
                        >
                          {c.status === "draft"
                            ? t("countStatusDraft")
                            : t("countStatusClosed")}
                        </span>
                      </div>
                      <div className="text-[11px] text-op-muted mt-0.5 truncate">
                        {[
                          t("countItems", { count: c._count.items }),
                          c.createdBy?.name ?? null,
                          c.notes,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <span className="text-op-muted text-sm shrink-0">
                      {openingId === c.id ? t("loading") : "›"}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {sheet && (
        <MovementSheet
          mode={sheet}
          ingredients={activeIngredients}
          currency={currency}
          onClose={() => setSheet(null)}
          onDone={handleMovementDone}
        />
      )}

      {newCountOpen && (
        <NewCountSheet
          ingredients={activeIngredients}
          onClose={() => setNewCountOpen(false)}
          onCreated={(count) => {
            setNewCountOpen(false);
            setCounts(null); // lista stale → refetch al volver al tab
            setCountsErr(false);
            setOpenCount(count);
          }}
        />
      )}

      {openCount && (
        <CountSheet
          count={openCount}
          onClose={() => setOpenCount(null)}
          onClosed={handleCountClosed}
        />
      )}

      {invSettingsOpen && (
        <InventorySettingsSheet
          onClose={() => setInvSettingsOpen(false)}
          onSaved={() => {
            setInvSettingsOpen(false);
            // Las categorías excluidas cambian qué insumos ve el server
            // (existencias/reorden) → recomponer la página.
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

/* ─────────── Ajustes: categorías sin inventario (spec A4·D6) ────────── */

function InventorySettingsSheet({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("opErp");
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState(false);
  const [categories, setCategories] = useState<string[]>([]);
  // Set de categorías EXCLUIDAS (sin inventario). El toggle de la fila es
  // "maneja inventario" → marcado = NO está en este set.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/operator/inventory-settings");
        if (!r.ok) throw new Error("load_failed");
        const j = (await r.json()) as {
          excludedCategories: string[];
          categories: string[];
        };
        if (cancelled) return;
        setCategories(j.categories ?? []);
        setExcluded(new Set(j.excludedCategories ?? []));
        setLoaded(true);
      } catch {
        if (!cancelled) setLoadErr(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(cat: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  }

  async function save() {
    setErr(null);
    setBusy(true);
    // Solo mandamos excluidas que sigan siendo categorías vigentes.
    const payload = categories.filter((c) => excluded.has(c));
    const r = await fetch("/api/operator/inventory-settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inventoryExcludedCategories: payload }),
    });
    setBusy(false);
    if (!r.ok) {
      setErr(t("errSaveFailed"));
      return;
    }
    onSaved();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-lg bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-display text-2xl">{t("invSettingsTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>
        <p className="text-xs text-op-muted mb-4">{t("invSettingsHint")}</p>

        {loadErr ? (
          <div className="text-xs text-danger">{t("errLoadFailed")}</div>
        ) : !loaded ? (
          <div className="py-6 text-center text-sm text-op-muted">
            {t("loading")}
          </div>
        ) : categories.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-op-border bg-op-bg/50 p-8 text-center text-sm text-op-muted">
            {t("invSettingsNoCategories")}
          </div>
        ) : (
          <div className="border border-op-border rounded-2xl overflow-hidden">
            {categories.map((c) => {
              const manages = !excluded.has(c);
              return (
                <label
                  key={c}
                  className="flex items-center gap-3 px-4 py-3 min-h-[44px] border-b border-op-border last:border-b-0 cursor-pointer hover:bg-op-bg"
                >
                  <span className="flex-1 min-w-0 text-sm font-medium truncate">
                    {c}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] text-op-muted">
                      {t("invSettingsManagesInventory")}
                    </span>
                    <input
                      type="checkbox"
                      checked={manages}
                      onChange={() => toggle(c)}
                      className="w-4 h-4 accent-ink shrink-0"
                    />
                  </span>
                </label>
              );
            })}
          </div>
        )}

        {err && <div className="text-xs text-danger mt-3">{err}</div>}

        <div className="flex items-center justify-end gap-3 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy || !loaded || loadErr}
            className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
          >
            {busy ? t("saving") : t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────── Sheet de movimiento (entrada/ajuste/merma) ────── */

const SHEET_TITLE_KEYS: Record<SheetMode, string> = {
  entry: "sheetEntryTitle",
  adjust: "sheetAdjustTitle",
  waste: "sheetWasteTitle",
};

function MovementSheet({
  mode,
  ingredients,
  currency,
  onClose,
  onDone,
}: {
  mode: SheetMode;
  ingredients: StockRow[];
  currency: string;
  onClose: () => void;
  onDone: (ingredientId: string, level: StockLevel) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [selected, setSelected] = useState<StockRow | null>(null);
  const [ingQ, setIngQ] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const [cost, setCost] = useState("");
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [reason, setReason] = useState<WasteReason | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const kind = selected?.measureKind ?? null;
  const unitOptions = kind ? DISPLAY_UNITS[kind] : [];

  const matches = useMemo(() => {
    const needle = fold(ingQ.trim());
    return ingredients
      .filter((i) => !needle || fold(i.name).includes(needle))
      .slice(0, 8);
  }, [ingredients, ingQ]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!selected || !kind) return;

    const qtyBase = toBaseQty(Number(qty.replace(",", ".")), kind, unit);
    if (qtyBase == null) {
      setErr(t("errContentInvalid"));
      return;
    }

    const payload: Record<string, unknown> = {
      ingredientId: selected.id,
      kind:
        mode === "entry"
          ? "purchase_in"
          : mode === "waste"
            ? "waste"
            : direction === "in"
              ? "adjust_in"
              : "adjust_out",
      qtyBase,
      note: note.trim() || null,
    };
    if (mode === "entry" && cost.trim() !== "") {
      const p = Number(cost.replace(",", "."));
      if (!isFinite(p) || p < 0) {
        setErr(t("errCostInvalid"));
        return;
      }
      payload.totalCostCents = pesosToCents(p);
    }
    if (mode === "waste") {
      if (!reason) return;
      payload.wasteReason = reason;
    }

    setBusy(true);
    const r = await fetch("/api/operator/stock/movements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const key = API_ERROR_KEYS[j.error as string];
      setErr(key ? t(key) : t("errSaveFailed"));
      return;
    }
    const j = await r.json();
    onDone(selected.id, j.level as StockLevel);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-lg bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <h2 className="font-display text-2xl">{t(SHEET_TITLE_KEYS[mode])}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <Field label={t("fieldIngredient")} required>
            {selected ? (
              <div className="min-h-[44px] px-3 rounded-lg border border-op-border bg-op-surface text-sm flex items-center justify-between gap-2">
                <span className="truncate">
                  {`${selected.name} (${unitSymbols(selected.measureKind)})`}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setIngQ("");
                    setQty("");
                    setUnit("");
                  }}
                  className="text-[11px] font-medium text-op-muted hover:text-ink shrink-0"
                >
                  {t("changeIngredient")}
                </button>
              </div>
            ) : (
              <div>
                <input
                  type="search"
                  value={ingQ}
                  onChange={(e) => setIngQ(e.target.value)}
                  placeholder={t("ingredientSearchPlaceholder")}
                  className={inputCls}
                />
                <div className="mt-1 rounded-lg border border-op-border bg-op-surface overflow-hidden max-h-44 overflow-y-auto">
                  {matches.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-op-muted">
                      {t("noIngredientMatches")}
                    </div>
                  ) : (
                    matches.map((i) => (
                      <button
                        key={i.id}
                        type="button"
                        onClick={() => {
                          setSelected(i);
                          setUnit(BASE_UNIT_SYMBOL[i.measureKind]);
                        }}
                        className="w-full min-h-[40px] px-3 py-1.5 text-left text-sm hover:bg-op-bg border-b border-op-border last:border-b-0"
                      >
                        <span>{i.name}</span>
                        <span className="font-mono text-[10px] text-op-muted ml-2">
                          {unitSymbols(i.measureKind)}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
            {selected && (
              <div className="text-[10px] text-op-muted mt-1">
                {`${t("currentStockLabel")}: ${formatBaseQty(
                  selected.stockLevel?.qtyBase ?? 0,
                  selected.measureKind,
                  locale,
                )}`}
              </div>
            )}
          </Field>

          {mode === "adjust" && (
            <Field label={t("fieldAdjustDirection")} required>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["in", t("adjustDirIn")],
                    ["out", t("adjustDirOut")],
                  ] as ["in" | "out", string][]
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setDirection(value)}
                    className={
                      "min-h-[44px] px-2 rounded-xl border text-sm font-medium transition-colors " +
                      (direction === value
                        ? "border-ink bg-ink text-bone"
                        : "border-op-border bg-op-bg hover:bg-op-surface")
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>
          )}

          <Field label={t("fieldQty")} required>
            <div className="flex gap-2">
              <input
                type="number"
                required
                min={0}
                step="any"
                inputMode="decimal"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                disabled={!kind}
                className={inputCls + " flex-1 disabled:opacity-40"}
              />
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                disabled={!kind || unitOptions.length < 2}
                className="min-h-[44px] w-24 px-3 rounded-lg border border-op-border bg-op-bg text-sm disabled:opacity-40"
              >
                {unitOptions.map((u) => (
                  <option key={u.symbol} value={u.symbol}>
                    {u.symbol}
                  </option>
                ))}
              </select>
            </div>
          </Field>

          {mode === "entry" && (
            <Field
              label={`${t("fieldTotalCost")} (${currency})`}
              hint={t("entryCostHint")}
            >
              <MoneyInput
                value={cost}
                onChange={setCost}
                className={inputCls}
              />
            </Field>
          )}

          {mode === "waste" && (
            <Field label={t("fieldWasteReason")} required>
              <select
                required
                value={reason}
                onChange={(e) => setReason(e.target.value as WasteReason | "")}
                className={inputCls}
              >
                <option value="" disabled hidden />
                {WASTE_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {t(WASTE_REASON_KEYS[r])}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <Field
            label={t("fieldNotes")}
            hint={mode === "adjust" ? t("adjustNoteHint") : undefined}
          >
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              rows={2}
              className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40"
            />
          </Field>

          {err && <div className="text-xs text-danger">{err}</div>}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              disabled={
                busy ||
                !selected ||
                qty.trim().length === 0 ||
                (mode === "waste" && !reason)
              }
              className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
            >
              {busy ? t("saving") : t("registerMovement")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─────────────────── Conteos físicos (spec D5) ─────────────────────── */

/**
 * Parsea la cantidad contada digitada. A diferencia de los movimientos,
 * en un conteo "0" es un dato válido ("conté y no hay") y distinto de
 * vacío ("sin contar" → null); toBaseQty rechaza 0, así que el cero se
 * maneja explícito antes de convertir.
 */
function parseCounted(
  raw: string,
  kind: MeasureKind,
  unitSymbol: string,
): number | null | "invalid" {
  const s = raw.trim();
  if (s === "") return null;
  const n = Number(s.replace(",", "."));
  if (!isFinite(n) || n < 0) return "invalid";
  if (n === 0) return 0;
  return toBaseQty(n, kind, unitSymbol) ?? "invalid";
}

function NewCountSheet({
  ingredients,
  onClose,
  onCreated,
}: {
  ingredients: StockRow[];
  onClose: () => void;
  onCreated: (count: CountDetail) => void;
}) {
  const t = useTranslations("opErp");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const i of ingredients) if (i.category) set.add(i.category);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [ingredients]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const r = await fetch("/api/operator/stock/counts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        category: category || null,
        notes: notes.trim() || null,
      }),
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(
        j.error === "count_open_exists"
          ? t("errCountOpenExists")
          : j.error === "no_ingredients"
            ? t("errNoIngredients")
            : t("errSaveFailed"),
      );
      return;
    }
    const j = await r.json();
    onCreated(j.count as CountDetail);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-lg bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <h2 className="font-display text-2xl">{t("newCountTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>
        <p className="text-xs text-op-muted mb-4">{t("newCountHint")}</p>

        <form onSubmit={submit} className="space-y-3">
          <Field label={t("fieldCountScope")}>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className={inputCls}
            >
              <option value="">{t("scopeAllActive")}</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t("fieldNotes")}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              rows={2}
              className="w-full px-3 py-2 rounded-lg border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40"
            />
          </Field>

          {err && <div className="text-xs text-danger">{err}</div>}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
            >
              {busy ? t("creating") : t("createCount")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CountSheet({
  count,
  onClose,
  onClosed,
}: {
  count: CountDetail;
  onClose: () => void;
  onClosed: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;

  // Borrador digitado: raw por item ("" = sin contar) + unidad de display.
  // Al reanudar, lo ya guardado se muestra en unidad base (sin ambigüedad).
  const [entries, setEntries] = useState<
    Record<string, { raw: string; unit: string }>
  >(() => {
    const init: Record<string, { raw: string; unit: string }> = {};
    for (const it of count.items) {
      init[it.id] = {
        raw: it.countedQty == null ? "" : String(it.countedQty),
        unit: BASE_UNIT_SYMBOL[it.ingredient.measureKind],
      };
    }
    return init;
  });
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [closedResult, setClosedResult] = useState<number | null>(null);

  const readOnly = count.status === "closed" || closedResult !== null;

  const visibleItems = useMemo(() => {
    const needle = fold(q.trim());
    if (!needle) return count.items;
    return count.items.filter((it) =>
      fold(`${it.ingredient.name} ${it.ingredient.category ?? ""}`).includes(
        needle,
      ),
    );
  }, [count.items, q]);

  // Desviación en vivo: contados y con diferencia (borrador usa lo
  // digitado; cerrado usa lo persistido).
  const stats = useMemo(() => {
    let counted = 0;
    let diffs = 0;
    for (const it of count.items) {
      const v = readOnly
        ? it.countedQty
        : parseCounted(
            entries[it.id]?.raw ?? "",
            it.ingredient.measureKind,
            entries[it.id]?.unit ?? BASE_UNIT_SYMBOL[it.ingredient.measureKind],
          );
      if (v == null || v === "invalid") continue;
      counted++;
      if (v !== it.expectedQty) diffs++;
    }
    return { counted, diffs };
  }, [count.items, entries, readOnly]);

  /** Payload PATCH completo, o null si hay alguna cantidad inválida. */
  function buildPayload(): { itemId: string; countedQty: number | null }[] | null {
    const out: { itemId: string; countedQty: number | null }[] = [];
    for (const it of count.items) {
      const e = entries[it.id];
      const parsed = parseCounted(e.raw, it.ingredient.measureKind, e.unit);
      if (parsed === "invalid") return null;
      out.push({ itemId: it.id, countedQty: parsed });
    }
    return out;
  }

  async function patchDraft(): Promise<boolean> {
    const items = buildPayload();
    if (!items) {
      setErr(t("errQtyInvalid"));
      return false;
    }
    const r = await fetch(`/api/operator/stock/counts/${count.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(
        j.error === "already_closed"
          ? t("errAlreadyClosed")
          : j.error === "qty_invalid"
            ? t("errQtyInvalid")
            : t("errSaveFailed"),
      );
      return false;
    }
    return true;
  }

  async function save() {
    setErr(null);
    setSavedFlash(false);
    setBusy(true);
    const ok = await patchDraft();
    setBusy(false);
    if (ok) setSavedFlash(true);
  }

  async function closeSession() {
    setErr(null);
    setSavedFlash(false);
    if (buildPayload() === null) {
      setErr(t("errQtyInvalid"));
      return;
    }
    if (!window.confirm(t("closeCountConfirm"))) return;
    setBusy(true);
    // Guardar primero: el cierre genera ajustes contra lo persistido.
    if (!(await patchDraft())) {
      setBusy(false);
      return;
    }
    const r = await fetch(`/api/operator/stock/counts/${count.id}/close`, {
      method: "POST",
    });
    setBusy(false);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setErr(
        j.error === "already_closed" ? t("errAlreadyClosed") : t("errSaveFailed"),
      );
      return;
    }
    const j = await r.json();
    setClosedResult((j.adjustments as number) ?? 0);
    onClosed();
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-lg bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="font-display text-2xl">{t("countTitle")}</h2>
            <span
              className={
                "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium shrink-0 " +
                (readOnly ? "bg-paper text-op-muted" : "bg-ink text-bone")
              }
            >
              {readOnly ? t("countStatusClosed") : t("countStatusDraft")}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>
        <div className="text-[11px] text-op-muted mb-1">
          {[
            formatDate(count.createdAt, { locale }),
            count.createdBy?.name ?? null,
            count.notes,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {/* Desviación en unidades; el valor en $ queda en los movimientos
            count_adjust del libro (tab Movimientos). */}
        <div className="text-xs text-op-muted mb-3">
          {`${t("summaryCounted", { count: stats.counted })} · ${t(
            "summaryWithDiff",
            { count: stats.diffs },
          )}`}
        </div>

        {closedResult !== null && (
          <div className="rounded-xl border border-op-border bg-op-bg px-4 py-3 text-sm text-ok mb-3">
            {t("closeCountResult", { count: closedResult })}
          </div>
        )}

        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("searchCountPlaceholder")}
          className="w-full min-h-[44px] px-4 rounded-full border border-op-border bg-op-bg text-sm focus:outline-none focus:border-op-text/40 mb-3"
        />

        {visibleItems.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-op-border bg-op-bg/50 p-6 text-center text-sm text-op-muted">
            {t("emptyFiltered")}
          </div>
        ) : (
          <div className="border border-op-border rounded-2xl overflow-hidden">
            {visibleItems.map((it) => {
              const kind = it.ingredient.measureKind;
              const unitOptions = DISPLAY_UNITS[kind];
              const entry = entries[it.id];
              const parsed = readOnly
                ? it.countedQty
                : parseCounted(entry.raw, kind, entry.unit);
              const diff =
                parsed != null && parsed !== "invalid"
                  ? parsed - it.expectedQty
                  : null;
              const diffCls =
                diff == null || diff === 0
                  ? "text-op-muted"
                  : diff > 0
                    ? "text-ok"
                    : "text-danger";
              const diffText =
                diff == null
                  ? "—"
                  : (diff > 0 ? "+" : diff < 0 ? "−" : "") +
                    formatBaseQty(Math.abs(diff), kind, locale);
              return (
                <div
                  key={it.id}
                  className="px-4 py-3 border-b border-op-border last:border-b-0"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium truncate">
                          {it.ingredient.name}
                        </span>
                        {!it.ingredient.active && (
                          <span className="px-2 h-5 inline-flex items-center rounded-full bg-paper text-op-muted text-[10px] font-medium shrink-0">
                            {t("inactiveBadge")}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-op-muted mt-0.5 truncate">
                        {`${t("expectedLabel")}: ${formatBaseQty(
                          it.expectedQty,
                          kind,
                          locale,
                        )}`}
                      </div>
                    </div>
                    {readOnly && (
                      <div className="text-right shrink-0">
                        <div className="text-sm tabular-nums">
                          {parsed == null
                            ? t("notCounted")
                            : formatBaseQty(parsed as number, kind, locale)}
                        </div>
                        {parsed != null && (
                          <div
                            className={
                              "text-[11px] mt-0.5 tabular-nums " + diffCls
                            }
                          >
                            {diffText}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {!readOnly && (
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="number"
                        min={0}
                        step="any"
                        inputMode="decimal"
                        value={entry.raw}
                        placeholder={t("notCounted")}
                        onChange={(e) => {
                          setSavedFlash(false);
                          setEntries((prev) => ({
                            ...prev,
                            [it.id]: { ...prev[it.id], raw: e.target.value },
                          }));
                        }}
                        className={inputCls + " flex-1"}
                      />
                      <select
                        value={entry.unit}
                        onChange={(e) => {
                          setSavedFlash(false);
                          setEntries((prev) => ({
                            ...prev,
                            [it.id]: { ...prev[it.id], unit: e.target.value },
                          }));
                        }}
                        disabled={unitOptions.length < 2}
                        className="min-h-[44px] w-20 px-2 rounded-lg border border-op-border bg-op-bg text-sm disabled:opacity-40"
                      >
                        {unitOptions.map((u) => (
                          <option key={u.symbol} value={u.symbol}>
                            {u.symbol}
                          </option>
                        ))}
                      </select>
                      <div
                        className={
                          "w-24 text-right text-xs font-medium tabular-nums shrink-0 " +
                          (parsed === "invalid" ? "text-danger" : diffCls)
                        }
                      >
                        {parsed === "invalid" ? "✕" : diffText}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {err && <div className="text-xs text-danger mt-3">{err}</div>}
        {savedFlash && !err && (
          <div className="text-xs text-ok mt-3">{t("draftSaved")}</div>
        )}

        <div className="sticky bottom-0 -mx-5 px-5 mt-4 pt-3 pb-1 bg-op-surface border-t border-op-border flex items-center justify-end gap-3">
          {readOnly ? (
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface"
            >
              {t("cancel")}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="min-h-[44px] px-4 rounded-full bg-op-bg border border-op-border text-sm font-medium hover:bg-op-surface disabled:opacity-40"
              >
                {busy ? t("saving") : t("saveDraft")}
              </button>
              <button
                type="button"
                onClick={closeSession}
                disabled={busy}
                className="min-h-[44px] px-5 rounded-full bg-ink text-bone text-sm font-medium disabled:opacity-40"
              >
                {busy ? t("closing") : t("closeCount")}
              </button>
            </>
          )}
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
