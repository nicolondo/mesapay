"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { sanitizeDecimalInput } from "@/lib/decimalInput";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, pesosToCents } from "@/lib/format";
import { BARCODE_MAX_LENGTH, ingredientBarcodeValues, mergeIngredientBarcodes, normalizeBarcode, type IngredientBarcodeUpdate } from "@/lib/erp/barcode";
import { applyArchive, fold } from "@/lib/erp/inventoryView";
import { IngredientBarcodes } from "./IngredientBarcodes";
import { CountQuantityFields } from "./CountQuantityFields";
import { countEntriesFromBase, parseCountEntry as parseCounted, parseCountEntries, nextCountEntry, formatCountQty, type CountEntry } from "@/lib/erp/stockCountInput";
import { effectiveCountParts, MAX_COUNT_PARTS } from "@/lib/erp/stockCountParts";
import { MoneyInput } from "@/components/MoneyInput";
import {
  DEFAULT_INPUT_UNIT,
  DISPLAY_UNITS,
  formatBaseQty,
  toBaseQty,
  type MeasureKind,
} from "@/lib/erp/units";
import { BarcodeSheet } from "./BarcodeSheet";
import { CountsTab } from "./CountsTab";
import { InvIcon } from "./InventoryIcons";
import { MovementsTab } from "./MovementsTab";
import { StockTab } from "./StockTab";
import {
  TAB_PARAM,
  WASTE_REASONS,
  WASTE_REASON_KEYS,
  type CountDetail,
  type CountItemRow,
  type SheetMode,
  type StockLevel,
  type StockRow,
  type Tab,
  type WasteReason,
} from "./types";

/** "g/kg", "ml/L", "un" — símbolos de unidad, iguales en es/en/pt. */
function unitSymbols(kind: MeasureKind): string {
  return DISPLAY_UNITS[kind].map((u) => u.symbol).join("/");
}

// Errores de la API de movimientos → clave i18n (fallback errSaveFailed).
const API_ERROR_KEYS: Record<string, string> = {
  qty_invalid: "errContentInvalid",
  cost_invalid: "errCostInvalid",
  ingredient_inactive: "errIngredientInactive",
  ingredient_not_tracked: "errIngredientNotTracked",
  ingredient_not_found: "errIngredientNotFound",
};

const TABS: Tab[] = ["stock", "movements", "counts"];
const TAB_LABEL_KEYS: Record<Tab, string> = { stock: "tabStock", movements: "tabMovements", counts: "tabCounts" };

/** Esc cierra las hojas simples (las que no usan <dialog> nativo). */
function useEscapeToClose(onClose: () => void, enabled = true) {
  const ref = useRef(onClose);
  useEffect(() => {
    ref.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") ref.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

type Notice = { tone: "ok" | "error"; text: string };

export function InventarioClient({
  initial,
  currency,
  initialTab = "stock",
}: {
  initial: StockRow[];
  currency: string;
  initialTab?: Tab;
}) {
  const t = useTranslations("opErp");
  const router = useRouter();
  const [rows, setRows] = useState<StockRow[]>(initial);
  const [tab, setTab] = useState<Tab>(initialTab);
  // Las pestañas se montan la primera vez que se abren y después solo se
  // esconden: conservan filtros, orden, página y lo ya cargado.
  const [visited, setVisited] = useState<ReadonlySet<Tab>>(() => new Set([initialTab]));
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  // Ajustes de categorías sin inventario — sheet propio (carga perezosa).
  const [invSettingsOpen, setInvSettingsOpen] = useState(false);
  const [sheet, setSheet] = useState<{ mode: SheetMode; ingredientId: string | null } | null>(null);
  const [barcodeFor, setBarcodeFor] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Movimientos: filtro por insumo (lo fija «Ver movimientos») y versión
  // para invalidar lo cargado cuando se registra algo nuevo.
  const [movementIngredient, setMovementIngredient] = useState<string | null>(null);
  const [movementsVersion, setMovementsVersion] = useState(0);

  // Conteos.
  const [countsVersion, setCountsVersion] = useState(0);
  const [newCountOpen, setNewCountOpen] = useState(false);
  const [openCount, setOpenCount] = useState<CountDetail | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const activeIngredients = useMemo(() => rows.filter((r) => r.active), [rows]);
  const barcodeRow = barcodeFor ? rows.find((r) => r.id === barcodeFor) ?? null : null;

  function updateBarcodes(ingredient: IngredientBarcodeUpdate) {
    setRows((current) => current.map((row) => row.id === ingredient.id ? mergeIngredientBarcodes(row, ingredient) : row));
  }

  function selectTab(next: Tab, focus = false) {
    setTab(next);
    setVisited((current) => (current.has(next) ? current : new Set([...current, next])));
    // La pestaña queda en la URL (?tab=…) sin navegar ni mover el scroll.
    const url = new URL(window.location.href);
    if (next === "stock") url.searchParams.delete("tab");
    else url.searchParams.set("tab", TAB_PARAM[next]);
    window.history.replaceState(null, "", url);
    if (focus) tabRefs.current[next]?.focus();
  }

  function onTabKeyDown(event: React.KeyboardEvent) {
    const index = TABS.indexOf(tab);
    const next =
      event.key === "ArrowRight" ? TABS[(index + 1) % TABS.length]
      : event.key === "ArrowLeft" ? TABS[(index - 1 + TABS.length) % TABS.length]
      : event.key === "Home" ? TABS[0]
      : event.key === "End" ? TABS[TABS.length - 1]
      : null;
    if (!next) return;
    event.preventDefault();
    selectTab(next, true);
  }

  function openMovement(mode: SheetMode, row?: StockRow) {
    setNotice(null);
    setSheet({ mode, ingredientId: row?.id ?? null });
  }

  function viewMovements(row: StockRow) {
    setMovementIngredient(row.id);
    selectTab("movements");
  }

  async function toggleArchive(row: StockRow) {
    if (archivingId) return;
    const archiving = row.active;
    if (archiving && !window.confirm(t("archiveConfirm", { name: row.name }))) return;
    setArchivingId(row.id);
    setNotice(null);
    try {
      const r = await fetch(`/api/operator/ingredients/${row.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ active: !row.active }),
      });
      if (!r.ok) throw new Error("archive_failed");
      const j = await r.json();
      if (j.ingredient?.id !== row.id || j.ingredient.active !== !row.active) throw new Error("invalid_archive_response");
      setRows((prev) => applyArchive(prev, row.id, !row.active));
      const hasStock = (row.stockLevel?.qtyBase ?? 0) !== 0;
      setNotice({
        tone: "ok",
        text: archiving
          ? t(hasStock ? "archivedNoticeStock" : "archivedNoticeGone", { name: row.name })
          : t("restoredNotice", { name: row.name }),
      });
    } catch {
      setNotice({ tone: "error", text: t("errSaveFailed") });
    } finally {
      setArchivingId(null);
    }
  }

  async function openSession(id: string) {
    if (openingId) return;
    setOpeningId(id);
    setNotice(null);
    try {
      const r = await fetch(`/api/operator/stock/counts/${id}`);
      if (!r.ok) throw new Error("load_failed");
      const j = await r.json();
      setOpenCount(j.count as CountDetail);
    } catch {
      setNotice({ tone: "error", text: t("errLoadFailed") });
    }
    setOpeningId(null);
  }

  // Cierre de conteo: los ajustes tocan N saldos a la vez → se refrescan
  // las existencias completas desde el server y se invalidan historial y
  // lista de sesiones (misma filosofía que handleMovementDone).
  async function reloadStock() {
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

  async function handleCountClosed() {
    setCountsVersion((v) => v + 1);
    setMovementsVersion((v) => v + 1);
    await reloadStock();
  }

  // Movimiento registrado: el saldo del row viene del server (fuente de
  // verdad) y el historial cargado queda viejo → se invalida.
  function handleMovementDone(ingredientId: string, level: StockLevel) {
    const name = rows.find((r) => r.id === ingredientId)?.name ?? "";
    setRows((prev) => prev.map((r) => (r.id === ingredientId ? { ...r, stockLevel: level } : r)));
    setMovementsVersion((v) => v + 1);
    setSheet(null);
    setNotice({ tone: "ok", text: t("movementSavedNotice", { name }) });
  }

  return (
    <div>
      <header className="mp-page-header mp-inv-header">
        <div className="min-w-0">
          <h1 className="mp-page-title">{t("inventarioTitle")}</h1>
          <p className="mp-page-description">{t("inventarioIntro")}</p>
        </div>
        {/* Registrar un movimiento: Entrada es la acción principal; Ajuste
            y Merma, secundarias agrupadas. */}
        <div className="mp-inv-actions" role="group" aria-label={t("invActionsLabel")}>
          <button type="button" onClick={() => openMovement("entry")} className="mp-btn mp-btn--primary mp-btn--sm">
            <InvIcon name="plus" />
            {t("actionEntry")}
          </button>
          <div className="mp-btngroup">
            <button type="button" onClick={() => openMovement("adjust")} className="mp-btn mp-btn--secondary mp-btn--sm">
              {t("actionAdjust")}
            </button>
            <button type="button" onClick={() => openMovement("waste")} className="mp-btn mp-btn--secondary mp-btn--sm">
              {t("actionWaste")}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setInvSettingsOpen(true)}
            aria-label={t("invSettingsTitle")}
            title={t("invSettingsTitle")}
            className="mp-icobtn mp-inv-settings shrink-0"
          >
            <InvIcon name="settings" size={20} />
          </button>
        </div>
      </header>

      {/* Pestañas (los ajustes del módulo viven junto a las acciones). */}
      <div className="mp-inv-tabsrow">
        <div className="mp-seg no-scrollbar" role="tablist" aria-label={t("inventarioTitle")} onKeyDown={onTabKeyDown}>
          {TABS.map((value) => (
            <button
              key={value}
              ref={(el) => { tabRefs.current[value] = el; }}
              id={`inv-tab-${value}`}
              type="button"
              role="tab"
              aria-selected={tab === value}
              aria-controls={`inv-panel-${value}`}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => selectTab(value)}
              className="mp-seg__i"
            >
              {t(TAB_LABEL_KEYS[value])}
            </button>
          ))}
        </div>
      </div>

      {notice && (
        <div role={notice.tone === "error" ? "alert" : "status"} className={"mp-inv-notice" + (notice.tone === "error" ? " is-error" : "")}>
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label={t("closeSheet")} className="mp-inv-notice__close">
            <InvIcon name="close" size={16} />
          </button>
        </div>
      )}

      <div id="inv-panel-stock" role="tabpanel" aria-labelledby="inv-tab-stock" hidden={tab !== "stock"}>
        {visited.has("stock") && (
          <StockTab
            rows={rows}
            currency={currency}
            archivingId={archivingId}
            onMovement={openMovement}
            onViewMovements={viewMovements}
            onBarcodes={(row) => setBarcodeFor(row.id)}
            onToggleArchive={toggleArchive}
          />
        )}
      </div>
      <div id="inv-panel-movements" role="tabpanel" aria-labelledby="inv-tab-movements" hidden={tab !== "movements"}>
        {visited.has("movements") && (
          <MovementsTab
            key={movementIngredient ?? "all"}
            ingredients={rows}
            ingredientId={movementIngredient}
            onIngredientChange={setMovementIngredient}
            version={movementsVersion}
            currency={currency}
          />
        )}
      </div>
      <div id="inv-panel-counts" role="tabpanel" aria-labelledby="inv-tab-counts" hidden={tab !== "counts"}>
        {visited.has("counts") && (
          <CountsTab
            version={countsVersion}
            openingId={openingId}
            onNew={() => setNewCountOpen(true)}
            onOpen={openSession}
          />
        )}
      </div>

      {sheet && (
        <MovementSheet
          mode={sheet.mode}
          ingredients={activeIngredients}
          preselected={sheet.ingredientId ? activeIngredients.find((r) => r.id === sheet.ingredientId) ?? null : null}
          currency={currency}
          onClose={() => setSheet(null)}
          onDone={handleMovementDone}
        />
      )}

      {barcodeRow && (
        <BarcodeSheet ingredient={barcodeRow} onClose={() => setBarcodeFor(null)} onSaved={updateBarcodes} />
      )}

      {newCountOpen && (
        <NewCountSheet
          ingredients={activeIngredients}
          onClose={() => setNewCountOpen(false)}
          onCreated={(count) => {
            setNewCountOpen(false);
            setCountsVersion((v) => v + 1); // lista vieja → se vuelve a pedir
            setOpenCount(count);
          }}
        />
      )}

      {openCount && (
        <CountSheet
          count={openCount}
          onBarcodeSaved={updateBarcodes}
          onClose={() => setOpenCount(null)}
          onClosed={handleCountClosed}
          onDeleted={() => {
            // Un borrador no tocó saldos: basta con cerrar el sheet e
            // invalidar la lista (no hace falta refrescar existencias).
            setOpenCount(null);
            setCountsVersion((v) => v + 1);
          }}
        />
      )}

      {invSettingsOpen && (
        <InventorySettingsSheet
          onClose={() => setInvSettingsOpen(false)}
          onSaved={async () => {
            setInvSettingsOpen(false);
            // Las categorías excluidas cambian qué insumos ve el server
            // (existencias/reorden): se vuelven a pedir las existencias (el
            // estado local no se rehace con router.refresh) y se recompone
            // el resto de la página.
            await reloadStock();
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
  useEscapeToClose(onClose, !busy);

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
      // Sin cierre al tocar afuera: es un formulario, y un clic perdido borraba lo digitado.
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
    >
      <div
        className="w-full md:max-w-lg bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[90dvh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label={t("invSettingsTitle")}
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
  preselected,
  currency,
  onClose,
  onDone,
}: {
  mode: SheetMode;
  ingredients: StockRow[];
  /** Insumo ya elegido (desde el menú ⋯ de su fila). */
  preselected?: StockRow | null;
  currency: string;
  onClose: () => void;
  onDone: (ingredientId: string, level: StockLevel) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [selected, setSelected] = useState<StockRow | null>(preselected ?? null);
  const [ingQ, setIngQ] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState(preselected ? DEFAULT_INPUT_UNIT[preselected.measureKind] : "");
  const [cost, setCost] = useState("");
  const [direction, setDirection] = useState<"in" | "out">("in");
  const [reason, setReason] = useState<WasteReason | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEscapeToClose(onClose, !busy);

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
      // Sin cierre al tocar afuera: es un formulario, y un clic perdido borraba lo digitado.
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
    >
      <div
        className="w-full md:max-w-lg bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[90dvh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label={t(SHEET_TITLE_KEYS[mode])}
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
                          setUnit(DEFAULT_INPUT_UNIT[i.measureKind]);
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
                type="text"
                required
                inputMode="decimal"
                value={qty}
                onChange={(e) => setQty(sanitizeDecimalInput(e.target.value))}
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
  useEscapeToClose(onClose, !busy);

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
      // Sin cierre al tocar afuera: es un formulario, y un clic perdido borraba lo digitado.
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
    >
      <div
        className="w-full md:max-w-lg bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border p-5 max-h-[90dvh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label={t("newCountTitle")}
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
  count: initialCount,
  onClose,
  onClosed,
  onDeleted,
  onBarcodeSaved,
}: {
  count: CountDetail;
  onClose: () => void;
  onClosed: () => void;
  onDeleted: () => void;
  onBarcodeSaved: (ingredient: IngredientBarcodeUpdate) => void;
}) {
  const t = useTranslations("opErp");
  const [count, setCount] = useState(initialCount);
  const locale = useLocale() as Locale;

  // Cada escaneo conserva su propia cantidad y unidad; el total se deriva.
  const [entries, setEntries] = useState<Record<string, CountEntry[]>>(() => {
    const init: Record<string, CountEntry[]> = {};
    for (const it of count.items) {
      init[it.id] = countEntriesFromBase(it.countedQty, it.ingredient.measureKind, it.countedParts);
    }
    return init;
  });
  const [q, setQ] = useState("");
  const [requestBusy, setBusy] = useState(false);
  const [barcodeSaving, setBarcodeSaving] = useState(false);
  const busy = requestBusy || barcodeSaving;
  const [conflict, setConflict] = useState<"stock" | "count" | null>(null);
  const [differenceFilter, setDifferenceFilter] = useState<"all" | "shortage" | "surplus" | "pending">("all");
  const [err, setErr] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [closedResult, setClosedResult] = useState<number | null>(null);

  // ── Lectura de código de barras ──
  // Los lectores del mercado son HID ("tipo teclado"): teclean el código a
  // toda velocidad y rematan con un Enter. No hace falta cámara ni pedir
  // permisos: alcanza con un input enfocado que capture la ráfaga y
  // reaccione al submit. Funciona con cualquier lector USB o bluetooth.
  const [scan, setScan] = useState("");
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [unmatchedCode, setUnmatchedCode] = useState<string | null>(null);
  const [quantityErrorKey, setQuantityErrorKey] = useState<string | null>(null);
  // Item al que saltó el último escaneo. `seq` sube en cada lectura para
  // que re-escanear el MISMO código vuelva a enfocar (sin él, el estado no
  // cambia y el efecto no corre).
  const [hit, setHit] = useState<{ itemId: string; index: number; seq: number } | null>(null);
  const seqRef = useRef(0);
  const scanRef = useRef<HTMLInputElement | null>(null);
  const qtyRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const readOnly = count.status === "closed" || closedResult !== null;
  const phase = readOnly ? "closed" : count.finalReview ? "review" : count.recountStartedAt ? "recount" : count.preliminaryAt ? "preliminary" : "initial";
  const canEdit = phase === "initial" || phase === "recount";
  // Lo guardado, en la misma forma que `entries`: si difieren, hay
  // cantidades digitadas que se perderían al cerrar.
  const savedEntries = useMemo(
    () => JSON.stringify(Object.fromEntries(count.items.map((item) => [item.id, countEntriesFromBase(item.countedQty, item.ingredient.measureKind, item.countedParts)]))),
    [count],
  );
  const dirty = canEdit && JSON.stringify(entries) !== savedEntries;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  /** ✕ y Cancelar: con cantidades sin guardar, pregunta antes de perderlas. */
  function requestClose() {
    if (busy) return;
    if (dirty && !window.confirm(t("countUnsavedConfirm"))) return;
    onClose();
  }
  const finalStage = !!count.recountStartedAt;
  const baseline = (item: CountItemRow) => finalStage ? (item.finalExpectedQty ?? item.expectedQty) : item.expectedQty;
  const quantity = (item: CountItemRow) => {
    if (!canEdit) return item.countedQty;
    const parsed = parseCountEntries(entries[item.id] ?? [], item.ingredient.measureKind);
    return parsed === "invalid" ? parsed : parsed.countedQty;
  };

  function acceptCount(next: CountDetail) {
    setCount(next);
    setEntries(Object.fromEntries(next.items.map((item) => [item.id, countEntriesFromBase(item.countedQty, item.ingredient.measureKind, item.countedParts)])));
    setConflict(null);
    setDifferenceFilter("all");
    setQuantityErrorKey(null);
  }

  function showError(code?: string) {
    const keys: Record<string, string> = {
      count_changed: "countErrChanged", stock_changed: "countErrStockChanged",
      incomplete_count: "countErrIncomplete", empty_count: "countErrEmpty",
      preliminary_required: "countErrPreliminary", recount_required: "countErrRecount",
      review_required: "countErrReview", already_closed: "errAlreadyClosed", qty_invalid: "errQtyInvalid",
    };
    setErr(t(keys[code ?? ""] ?? "errSaveFailed"));
    if (code === "stock_changed") setConflict("stock");
    if (code === "count_changed" || code === "already_closed") setConflict("count");
  }

  async function requestCount(action: string, body?: unknown): Promise<CountDetail | null> {
    try {
      const response = await fetch(`/api/operator/stock/counts/${count.id}${action ? `/${action}` : ""}`, {
        method: action ? "POST" : "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { showError(result.error); return null; }
      acceptCount(result.count as CountDetail);
      return result.count as CountDetail;
    } catch { setErr(t("errSaveFailed")); return null; }
  }

  async function reloadCount() {
    setBusy(true); setErr(null);
    try {
      const response = await fetch(`/api/operator/stock/counts/${count.id}`);
      if (!response.ok) throw new Error("load_failed");
      acceptCount((await response.json()).count as CountDetail);
    } catch { setErr(t("errSaveFailed")); }
    finally { setBusy(false); }
  }

  const visibleItems = count.items.filter((item) => {
    const needle = fold(q.trim());
    if (needle && !fold(`${item.ingredient.name} ${item.ingredient.category ?? ""}`).includes(needle)) return false;
    if (differenceFilter === "all") return true;
    if (!item.ingredient.trackInventory) return false;
    // Keep editable rows stable until save, so typing the first digit never
    // removes a pending row or steals focus as its difference changes.
    const value = canEdit ? item.countedQty : quantity(item);
    if (differenceFilter === "pending") return value == null;
    if (value == null || value === "invalid") return false;
    return differenceFilter === "shortage" ? value < baseline(item) : value > baseline(item);
  });

  // Código de barras → item del conteo. El índice único
  // (restaurantId, barcode) garantiza que no haya dos insumos con el mismo
  // código, así que el mapa nunca pierde filas y el escaneo no es ambiguo.
  const byBarcode = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of count.items) {
      for (const code of ingredientBarcodeValues(it.ingredient)) m.set(code, it.id);
    }
    return m;
  }, [count.items]);

  /** Escaneo (o Enter manual): salta al insumo del código leído. */
  function handleScan(e: React.FormEvent) {
    e.preventDefault();
    if (!canEdit || busy) return;
    const code = normalizeBarcode(scan);
    setScan("");
    if (!code) return;
    const itemId = byBarcode.get(code);
    if (!itemId) {
      // Nunca fallar en silencio: el operador tiene el empaque en la mano
      // y necesita enterarse de que ese código no está en el conteo (o de
      // que al insumo le falta cargar el código en su ficha).
      setScanErr(t("errBarcodeNotFound", { code }));
      setUnmatchedCode(code);
      return;
    }
    setScanErr(null);
    setUnmatchedCode(null);
    addQuantity(itemId);
  }

  function addQuantity(itemId: string) {
    if (!canEdit || busy) return;
    const item = count.items.find((candidate) => candidate.id === itemId);
    if (!item?.ingredient.trackInventory) return;
    const next = nextCountEntry(entries[itemId] ?? [], item.ingredient.measureKind);
    if (!next) {
      setScanErr(t("countPartsLimit", { count: MAX_COUNT_PARTS }));
      return;
    }
    setEntries((prev) => ({ ...prev, [itemId]: next.entries }));
    setSavedFlash(false);
    setQuantityErrorKey(null);
    // El buscador puede estar escondiendo justo la fila escaneada.
    setQ("");
    setDifferenceFilter("all");
    setHit({ itemId, index: next.index, seq: ++seqRef.current });
  }

  // Enfocar la cantidad del insumo escaneado. Corre DESPUÉS del render, así
  // que la fila ya existe aunque el escaneo haya tenido que limpiar el
  // filtro de búsqueda para revelarla.
  useEffect(() => {
    if (!hit) return;
    const el = qtyRefs.current[`${hit.itemId}:${hit.index}`];
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus({ preventScroll: true });
    el.select();
  }, [hit]);

  // Desviación en vivo: contados y con diferencia (borrador usa lo
  // digitado; cerrado usa lo persistido).
  const stats = count.items.reduce((sum, item) => {
    if (!item.ingredient.trackInventory) return sum;
    const value = quantity(item);
    if (value == null || value === "invalid") { sum.pending++; return sum; }
    sum.counted++;
    const diff = value - baseline(item);
    if (diff < 0) sum.shortages++;
    if (diff > 0) sum.surpluses++;
    if (diff !== 0) sum.diffs++;
    else sum.equal++;
    return sum;
  }, { counted: 0, diffs: 0, shortages: 0, surpluses: 0, equal: 0, pending: 0 });

  /** Payload PATCH completo, o null si hay alguna cantidad inválida. */
  function buildPayload(): { itemId: string; countedQty: number | null; countedParts: number[] }[] | null {
    const out: { itemId: string; countedQty: number | null; countedParts: number[] }[] = [];
    for (const it of count.items) {
      const parsed = parseCountEntries(entries[it.id] ?? [], it.ingredient.measureKind);
      if (parsed === "invalid") return null;
      out.push({ itemId: it.id, ...parsed });
    }
    return out;
  }

  async function patchDraft(): Promise<CountDetail | null> {
    const items = buildPayload();
    if (!items) { setErr(t("errQtyInvalid")); return null; }
    return requestCount("", { revision: count.revision, items });
  }

  async function save() {
    setErr(null); setSavedFlash(false); setBusy(true);
    const saved = await patchDraft();
    setBusy(false);
    if (saved) setSavedFlash(true);
  }

  async function advance(action: "preliminary" | "recount" | "review") {
    setErr(null); setSavedFlash(false); setBusy(true);
    try {
      const saved = action === "recount" ? count : await patchDraft();
      if (saved) await requestCount(action, { revision: saved.revision });
    } finally { setBusy(false); }
  }

  /**
   * Borra la sesión — la API solo lo permite en BORRADOR. Un conteo
   * cerrado ya generó ajustes y movió saldos: borrarlo dejaría el stock
   * mintiendo, por eso ni se ofrece el botón (el pie en modo lectura no lo
   * incluye) y, si igual llegara la respuesta, se muestra el 409 traducido.
   */
  async function deleteSession() {
    setErr(null); setSavedFlash(false);
    if (!window.confirm(t("deleteCountConfirm"))) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/operator/stock/counts/${count.id}`, {
        method: "DELETE", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: count.revision }),
      });
      if (!response.ok) { showError((await response.json().catch(() => ({}))).error); return; }
      onDeleted();
    } catch { setErr(t("errSaveFailed")); }
    finally { setBusy(false); }
  }

  async function closeSession() {
    if (!count.finalReview) return;
    setErr(null); setBusy(true);
    try {
      const response = await fetch(`/api/operator/stock/counts/${count.id}/close`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: count.revision, reviewToken: count.finalReview.token }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { showError(result.error); return; }
      acceptCount(result.count as CountDetail);
      setClosedResult(result.adjustments ?? 0);
      onClosed();
    } catch { setErr(t("errSaveFailed")); }
    finally { setBusy(false); }
  }

  return (
    <div
      // Sin cierre al tocar afuera: es un formulario, y un clic perdido borraba lo digitado.
      className="fixed inset-0 z-50 bg-ink/40 flex items-end md:items-center justify-center p-0 md:p-6"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("countTitle")}
        className="w-full md:max-w-3xl bg-op-surface rounded-t-3xl md:rounded-3xl border border-op-border max-h-[90dvh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 pt-5 pb-3 border-b border-op-border">
        <div className="flex items-start justify-between gap-3 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="font-display text-2xl">{t("countTitle")}</h2>
            <span
              className={
                "px-2 h-5 inline-flex items-center rounded-full text-[10px] font-medium shrink-0 " +
                (readOnly ? "bg-paper text-op-muted" : "bg-ink text-bone")
              }
            >
              {t(readOnly ? "countStatusClosed" : phase === "initial" ? "countStageInitial" : phase === "preliminary" ? "countStagePreliminary" : phase === "review" ? "countStageReview" : "countStageDefinitive")}
            </span>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={busy}
            className="text-op-muted text-sm shrink-0 min-h-[44px] min-w-[44px] -mt-2 -mr-2"
            aria-label={t("cancel")}
          >
            {"✕"}
          </button>
        </div>
        {canEdit && (
          <form onSubmit={handleScan}>
            <Field label={t("scanBarcodeLabel")} hint={t("scanHint")}>
              <input
                ref={scanRef}
                type="text"
                value={scan}
                aria-label={t("scanBarcodeLabel")}
                // Los lectores HID escriben en el campo enfocado.
                autoFocus
                autoComplete="off"
                inputMode="text"
                enterKeyHint="go"
                disabled={busy}
                onChange={(e) => {
                  setScan(e.target.value);
                  setScanErr(null);
                }}
                placeholder={t("scanBarcodePlaceholder")}
                maxLength={BARCODE_MAX_LENGTH}
                className={inputCls + " font-mono"}
              />
            </Field>
            {scanErr && (
              <div role="alert" className="text-xs text-danger break-words mt-1">{scanErr}</div>
            )}
          </form>
        )}
        </div>
        <div role="region" aria-label={t("countScrollRegion")} className="min-h-0 overflow-y-auto overscroll-contain px-5 pt-3">
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

        {!readOnly && <div className="rounded-xl bg-op-bg border border-op-border p-3 mb-4 text-sm leading-relaxed">
          <p className="font-medium">{t(phase === "initial" ? "countInitialHint" : phase === "preliminary" ? "countPreliminaryHint" : phase === "review" ? "countReviewHint" : "countRecountHint")}</p>
          {(phase === "preliminary" || phase === "recount") && <p className="text-xs text-op-muted mt-2">{t("countRecountSafety")}</p>}
        </div>}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          {([
            ["countShortages", stats.shortages, "text-danger"],
            ["countSurpluses", stats.surpluses, "text-ok"],
            ["countEqual", stats.equal, "text-op-text"],
            ["countPending", stats.pending, "text-op-muted"],
          ] as const).map(([label, value, color]) => (
            <div key={label} className="rounded-xl border border-op-border px-3 py-2">
              <div className={"text-lg font-medium tabular-nums " + color}>{value}</div>
              <div className="text-xs text-op-muted">{t(label)}</div>
            </div>
          ))}
        </div>

        <div className="flex gap-2 flex-wrap mb-3" aria-label={t("countFilterLabel")}>
          {([ ["all", "filterAll"], ["shortage", "countShortages"], ["surplus", "countSurpluses"], ["pending", "countPending"] ] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={differenceFilter === value} onClick={() => setDifferenceFilter(value)} className={"min-h-[40px] rounded-full px-3 text-xs border " + (differenceFilter === value ? "bg-ink text-bone border-ink" : "border-op-border")}>{t(label)}</button>
          ))}
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
              const itemEntries = entries[it.id];
              const parsed = quantity(it);
              const initialParts = effectiveCountParts(it.preliminaryQty, it.preliminaryParts);
              const currentParts = effectiveCountParts(it.countedQty, it.countedParts);
              const diff =
                parsed != null && parsed !== "invalid"
                  ? parsed - baseline(it)
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
                    formatCountQty(Math.abs(diff), kind, locale);
              return (
                <div
                  key={it.id}
                  className={
                    "px-4 py-3 border-b border-op-border last:border-b-0 " +
                    // Feedback del escaneo: "es esta fila". Se apaga al
                    // escanear otro código.
                    (hit?.itemId === it.id ? "bg-op-bg" : "")
                  }
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
                        {`${t(finalStage ? "countFinalExpectedLabel" : "countInitialExpectedLabel")}: ${formatCountQty(
                          baseline(it),
                          kind,
                          locale,
                        )}`}
                      </div>
                    </div>
                    {!canEdit && (
                      <div className="text-right shrink-0">
                        <div className="text-sm tabular-nums">
                          {parsed == null
                            ? t("notCounted")
                            : formatCountQty(parsed as number, kind, locale)}
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
                  {count.preliminaryAt && (
                    <div className="text-xs text-op-muted mt-2">
                      {t("countInitialLabel")}: {it.preliminaryQty == null ? t("notCounted") : formatCountQty(it.preliminaryQty, kind, locale)}
                      {it.preliminaryQty != null && <span> · {t("countInitialDifference")}: {formatCountQty(it.preliminaryQty - it.expectedQty, kind, locale)}</span>}
                      {initialParts.length > 1 && <p className="mt-1 break-words">{t("countInitialParts", { amounts: initialParts.map(value => formatCountQty(value, kind, locale)).join(" + ") })}</p>}
                    </div>
                  )}
                  {!it.ingredient.trackInventory && <p className="text-xs text-op-muted mt-1">{t("nonInventoriable")}</p>}
                  {canEdit && (
                    <CountQuantityFields
                      itemId={it.id} name={it.ingredient.name} kind={kind} entries={itemEntries}
                      disabled={busy || !it.ingredient.trackInventory} tracked={it.ingredient.trackInventory}
                      invalidTotal={parsed === "invalid"} errorKey={quantityErrorKey}
                      setInputRef={(index, element) => { qtyRefs.current[`${it.id}:${index}`] = element; }}
                      onChange={(index, change) => {
                        setSavedFlash(false);
                        setQuantityErrorKey(null);
                        setEntries(prev => ({ ...prev, [it.id]: prev[it.id].map((entry, partIndex) => partIndex === index ? { ...entry, ...change } : entry) }));
                      }}
                      onEnter={(index) => {
                        const entry = itemEntries[index];
                        const value = parseCounted(entry.raw, kind, entry.unit);
                        if (value == null || value === "invalid" || parsed === "invalid") {
                          setQuantityErrorKey(`${it.id}:${index}`);
                          return;
                        }
                        setQuantityErrorKey(null);
                        setScan(""); setScanErr(null); setUnmatchedCode(null);
                        scanRef.current?.focus({ preventScroll: true });
                      }}
                      onRemove={(index) => {
                        const remaining = itemEntries.filter((_, partIndex) => partIndex !== index);
                        setEntries(prev => ({ ...prev, [it.id]: remaining }));
                        setSavedFlash(false); setQuantityErrorKey(null);
                        setHit({ itemId: it.id, index: Math.min(index, remaining.length - 1), seq: ++seqRef.current });
                      }}
                      onAdd={() => addQuantity(it.id)}
                    />
                  )}
                  {!canEdit && currentParts.length > 1 && (
                    <p className="mt-2 text-xs text-op-muted break-words">{t("countPartsBreakdown", { amounts: currentParts.map(value => formatCountQty(value, kind, locale)).join(" + ") })}</p>
                  )}
                  <div className="mt-2 flex items-start justify-between gap-3 border-t border-op-border pt-2">
                    <div role="status" aria-label={t("countTotalLabel", { name: it.ingredient.name })} className="min-w-0 text-sm font-medium">
                      <span className="text-xs text-op-muted">{t("countTotal")}</span>
                      <div className={"mt-0.5 tabular-nums " + (parsed === "invalid" ? "text-danger" : "")}>
                        {parsed === "invalid" ? t("countPartsInvalidTotal") : parsed == null ? t("notCounted") : formatCountQty(parsed, kind, locale)}
                      </div>
                    </div>
                    {canEdit && diff != null && (
                      <div className={"text-right text-xs font-medium tabular-nums " + diffCls}>
                        {diffText}
                        {diff !== 0 && <div className="text-[10px]">{t(diff < 0 ? "countShortage" : "countSurplus")}</div>}
                      </div>
                    )}
                  </div>
                  <IngredientBarcodes
                    ingredient={it.ingredient}
                    canAdd={canEdit && it.ingredient.active && it.ingredient.trackInventory}
                    disabled={busy}
                    suggestedCode={unmatchedCode}
                    onBusyChange={setBarcodeSaving}
                    onSaved={(ingredient) => {
                      // Only merge barcode metadata. acceptCount/reload would
                      // reconstruct entries and erase quantities not yet saved.
                      setCount((current) => ({ ...current, items: current.items.map((item) => item.ingredient.id === ingredient.id
                        ? { ...item, ingredient: mergeIngredientBarcodes(item.ingredient, ingredient) } : item) }));
                      onBarcodeSaved(ingredient);
                      setUnmatchedCode(null); setScanErr(null);
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}

        {err && <div role="alert" className="rounded-xl border border-danger/30 p-3 text-sm text-danger mt-3">
          {err}
          {conflict === "count" && <button type="button" disabled={busy} onClick={reloadCount} className="block mt-2 underline min-h-[44px]">{t("countReload")}</button>}
          {conflict === "stock" && <button type="button" disabled={busy} onClick={() => advance("recount")} className="block mt-2 underline min-h-[44px]">{t("countRestartRecount")}</button>}
        </div>}
        {savedFlash && !err && (
          <div className="text-xs text-ok mt-3">{t("draftSaved")}</div>
        )}

        <div className="sticky [@media(max-height:600px)]:static bottom-0 -mx-5 px-5 mt-4 pt-3 pb-5 bg-op-surface border-t border-op-border flex flex-wrap items-center justify-end gap-2">
          {readOnly ? (
            <button type="button" onClick={requestClose} className="mp-btn mp-btn--secondary">{t("cancel")}</button>
          ) : (
            <>
              <button type="button" onClick={deleteSession} disabled={busy} className="mr-auto min-h-[44px] px-3 text-danger text-sm disabled:opacity-40">{t("deleteCount")}</button>
              {canEdit && <button type="button" onClick={save} disabled={busy || !!conflict} className="mp-btn mp-btn--secondary">{busy ? t("saving") : t("saveDraft")}</button>}
              {phase === "initial" && <button type="button" onClick={() => advance("preliminary")} disabled={busy || !!conflict || stats.counted === 0} className="mp-btn mp-btn--primary">{t("countViewPreliminary")}</button>}
              {phase === "preliminary" && <button type="button" onClick={() => advance("recount")} disabled={busy || !!conflict} className="mp-btn mp-btn--primary">{t("countStartRecount")}</button>}
              {phase === "recount" && <button type="button" onClick={() => advance("review")} disabled={busy || !!conflict || stats.pending > 0 || stats.counted === 0} className="mp-btn mp-btn--primary">{t("countReviewFinal")}</button>}
              {phase === "review" && <>
                <button type="button" onClick={save} disabled={busy || !!conflict} className="mp-btn mp-btn--secondary">{t("countEditFinal")}</button>
                <button type="button" onClick={closeSession} disabled={busy || !!conflict} className="mp-btn mp-btn--primary">{busy ? t("closing") : t("countConfirmFinal")}</button>
              </>}
            </>
          )}
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

