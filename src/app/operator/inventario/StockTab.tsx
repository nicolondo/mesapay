"use client";

import { useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { ingredientBarcodeValues } from "@/lib/erp/barcode";
import { formatBaseQty } from "@/lib/erp/units";
import {
  DEFAULT_STOCK_FILTERS,
  filterStockRows,
  paginate,
  reorderState,
  sortDirection,
  stockCategories,
  stockChipCounts,
  summarizeStock,
  toggleSort,
  unitCost,
  STOCK_SORTS,
  type StockFilters,
  type StockSort,
  type StockSortColumn,
} from "@/lib/erp/inventoryView";
import { InvIcon } from "./InventoryIcons";
import { RowActionsMenu, type RowMenuItem } from "./RowActionsMenu";
import type { SheetMode, StockRow } from "./types";

// «2 nov 2026»: sin hora, la columna es de referencia.
const SHORT_DATE = { dateStyle: undefined, timeStyle: undefined, day: "numeric", month: "short", year: "numeric" } as const;

const SORT_LABEL_KEYS: Record<StockSort, string> = {
  name: "sortName", nameDesc: "sortNameDesc", qtyDesc: "sortQtyDesc", qtyAsc: "sortQtyAsc",
  valueDesc: "sortValueDesc", valueAsc: "sortValueAsc", avgDesc: "sortAvgDesc", avgAsc: "sortAvgAsc",
  movedDesc: "sortMovedDesc", movedAsc: "sortMovedAsc",
};

/**
 * Pestaña Existencias: barra de filtros (búsqueda, categoría y chips con
 * su conteo), tira de resumen sobre TODO lo filtrado, tabla compacta de una
 * línea por insumo (columnas que aparecen según el ancho disponible, con la
 * primera fija si hiciera falta desplazar) y tarjetas en el celular. Las
 * acciones de cada insumo viven en su menú ⋯.
 */
export function StockTab({
  rows,
  currency,
  archivingId,
  onMovement,
  onViewMovements,
  onBarcodes,
  onToggleArchive,
}: {
  rows: StockRow[];
  currency: string;
  archivingId: string | null;
  onMovement: (mode: SheetMode, row: StockRow) => void;
  onViewMovements: (row: StockRow) => void;
  onBarcodes: (row: StockRow) => void;
  onToggleArchive: (row: StockRow) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const [filters, setFilters] = useState<StockFilters>(DEFAULT_STOCK_FILTERS);
  const [sort, setSort] = useState<StockSort>("name");
  const [page, setPage] = useState(1);
  const listTop = useRef<HTMLDivElement | null>(null);

  const filtered = useMemo(() => filterStockRows(rows, filters, sort), [rows, filters, sort]);
  const summary = useMemo(() => summarizeStock(filtered), [filtered]);
  const chips = useMemo(
    () => stockChipCounts(rows, { q: filters.q, category: filters.category, showArchived: filters.showArchived }),
    [rows, filters.q, filters.category, filters.showArchived],
  );
  const categories = useMemo(() => stockCategories(rows), [rows]);
  const view = paginate(filtered, page);
  const hasArchived = rows.some((r) => !r.active);
  const filtering = filters.q.trim() !== "" || filters.category !== "all" || filters.lowOnly || filters.stockedOnly || filters.showArchived;

  function update(patch: Partial<StockFilters>) {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(1);
  }
  function changeSort(next: StockSort) {
    setSort(next);
    setPage(1);
  }
  function goTo(next: number) {
    setPage(next);
    // Al cambiar de página se vuelve al inicio de la LISTA, no de la página.
    requestAnimationFrame(() => listTop.current?.scrollIntoView({ block: "nearest" }));
  }

  const money = (cents: number) => formatMoney(cents, { currency, locale });
  const qtyText = (row: StockRow, base: number) => formatBaseQty(base, row.measureKind, locale);

  function menuItems(row: StockRow): RowMenuItem[] {
    const inactive = !row.active;
    return [
      { key: "entry", label: t("rowEntry"), icon: "plus", disabled: inactive, onSelect: () => onMovement("entry", row) },
      { key: "adjust", label: t("rowAdjust"), icon: "adjust", disabled: inactive, onSelect: () => onMovement("adjust", row) },
      { key: "waste", label: t("rowWaste"), icon: "minus", disabled: inactive, onSelect: () => onMovement("waste", row) },
      { key: "movements", label: t("rowViewMovements"), icon: "list", separatorBefore: true, onSelect: () => onViewMovements(row) },
      { key: "barcodes", label: t("rowBarcodes"), icon: "barcode", onSelect: () => onBarcodes(row) },
      { key: "edit", label: t("rowEdit"), icon: "pencil", href: `/operator/settings/insumos?editar=${encodeURIComponent(row.id)}` },
      {
        key: "archive",
        label: t(row.active ? "rowArchive" : "rowRestore"),
        icon: row.active ? "archive" : "restore",
        tone: row.active ? "danger" : undefined,
        separatorBefore: true,
        disabled: archivingId !== null,
        onSelect: () => onToggleArchive(row),
      },
    ];
  }

  // En el celular el aviso de bajo mínimo queda como ícono (el texto va
  // para lectores de pantalla) para no comerse el nombre del insumo.
  function badges(row: StockRow, compact = false) {
    const state = reorderState(row);
    return (
      <>
        {!row.active && <span className="mp-inv-pill shrink-0">{t("ingredientArchivedBadge")}</span>}
        {state === "low" && (
          <span className={"mp-inv-pill mp-inv-pill--low shrink-0" + (compact ? " mp-inv-pill--icon" : "")} title={compact ? t("reorderLowBadge") : undefined}>
            <InvIcon name="alert" size={13} />
            <span className={compact ? "sr-only" : undefined}>{t("reorderLowBadge")}</span>
          </span>
        )}
      </>
    );
  }

  function codesChip(row: StockRow) {
    const count = ingredientBarcodeValues(row).length;
    if (count === 0) return null;
    const label = t("barcodeCountLabel", { count });
    return (
      <button type="button" onClick={() => onBarcodes(row)} aria-label={`${label} · ${row.name}`} title={label} className="mp-inv-codechip shrink-0">
        <InvIcon name="barcode" size={13} />
        {count}
      </button>
    );
  }

  function th(label: string, { column, align, className = "" }: { column?: StockSortColumn; align?: "right"; className?: string } = {}) {
    const dir = column ? sortDirection(sort, column) : null;
    return (
      <th
        scope="col"
        aria-sort={column ? (dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none") : undefined}
        className={(align === "right" ? "text-right " : "text-left ") + className}
      >
        {column ? (
          <button type="button" onClick={() => changeSort(toggleSort(sort, column))} className={"mp-inv-sort" + (dir ? " is-active" : "")}>
            {label}
            <span aria-hidden className="mp-inv-sort__arrow">{dir === "asc" ? "↑" : dir === "desc" ? "↓" : "↕"}</span>
          </button>
        ) : (
          label
        )}
      </th>
    );
  }

  return (
    <div className="space-y-3">
      {/* Barra de filtros: una sola fila en escritorio. Cambiar un filtro
          reacomoda la lista sin mover la página. */}
      <div className="mp-inv-toolbar" role="search" aria-label={t("stockFiltersLabel")}>
        <label className="mp-search-field">
          <InvIcon name="search" />
          <input
            type="search"
            value={filters.q}
            onChange={(e) => update({ q: e.target.value })}
            placeholder={t("stockSearchPlaceholder")}
            aria-label={t("stockSearchPlaceholder")}
          />
        </label>
        {categories.length > 0 && (
          <select value={filters.category} onChange={(e) => update({ category: e.target.value })} aria-label={t("invColCategory")} className="mp-inv-select">
            <option value="all">{t("allCategories")}</option>
            {categories.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
        <select value={sort} onChange={(e) => changeSort(e.target.value as StockSort)} aria-label={t("sortLabel")} className="mp-inv-select md:hidden">
          {STOCK_SORTS.map((s) => (
            <option key={s} value={s}>{t(SORT_LABEL_KEYS[s])}</option>
          ))}
        </select>
        <div className="mp-inv-chips" role="group" aria-label={t("stockQuickFilters")}>
          <button type="button" onClick={() => update({ lowOnly: !filters.lowOnly })} aria-pressed={filters.lowOnly} className="mp-chip">
            {t("reorderLowBadge")}
            <span className="mp-chip__count">{chips.low}</span>
          </button>
          <button type="button" onClick={() => update({ stockedOnly: !filters.stockedOnly })} aria-pressed={filters.stockedOnly} className="mp-chip">
            {t("stockedOnly")}
            <span className="mp-chip__count">{chips.stocked}</span>
          </button>
          {hasArchived && (
            <button type="button" onClick={() => update({ showArchived: !filters.showArchived })} aria-pressed={filters.showArchived} title={t("archivedStockHint")} className="mp-chip">
              {t("filterArchivedIngredients")}
              <span className="mp-chip__count">{chips.archived}</span>
            </button>
          )}
        </div>
        {filtering && (
          <button type="button" onClick={() => update(DEFAULT_STOCK_FILTERS)} className="mp-inv-clear">
            {t("clearFilters")}
          </button>
        )}
      </div>
      {filters.showArchived && <p className="text-xs text-op-muted">{t("archivedStockHint")}</p>}

      <div ref={listTop} className="mp-inv-card scroll-mt-4">
        {/* Resumen del conjunto filtrado (todas las páginas). */}
        <div className="mp-inv-summary" aria-live="polite">
          <span>
            <strong>{t("invSummaryItems", { count: summary.items })}</strong>
          </span>
          <span>
            {t("invSummaryValue")} <strong>{money(summary.valueCents)}</strong>
          </span>
          {summary.lowCount > 0 &&
            (filters.lowOnly ? (
              <span className="mp-inv-summary__low">
                <InvIcon name="alert" size={14} />
                {t("invSummaryLow", { count: summary.lowCount })}
              </span>
            ) : (
              <button type="button" onClick={() => update({ lowOnly: true })} className="mp-inv-summary__low is-link">
                <InvIcon name="alert" size={14} />
                {t("invSummaryLow", { count: summary.lowCount })}
              </button>
            ))}
          {view.pageCount > 1 && (
            <span className="mp-inv-summary__range">{t("paginationShowing", { from: view.from, to: view.to, total: view.total })}</span>
          )}
        </div>

        {rows.length === 0 ? (
          <div className="p-8 text-center">
            <div className="text-base font-semibold mb-1">{t("emptyStockTitle")}</div>
            <p className="text-sm text-op-muted">{t("emptyStockBody")}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-op-muted">
            <p>{t("emptyFiltered")}</p>
            {filtering && (
              <button type="button" onClick={() => update(DEFAULT_STOCK_FILTERS)} className="mp-btn mp-btn--secondary mp-btn--sm mt-3">
                {t("clearFilters")}
              </button>
            )}
          </div>
        ) : (
          <>
            {/* Escritorio/tableta: una línea por insumo. Las columnas
                secundarias aparecen cuando el ancho de la tarjeta alcanza
                (container queries); si aun así no cupiera, la tabla se
                desplaza de lado con la primera columna fija. */}
            <div className="@container hidden md:block overflow-x-auto">
              <table className="mp-inv-table">
                <thead>
                  <tr>
                    {th(t("invColItem"), { column: "name", className: "mp-inv-sticky" })}
                    {th(t("invColCategory"), { className: "hidden @4xl:table-cell" })}
                    {th(t("invColQty"), { column: "qty", align: "right" })}
                    {th(t("invColMin"), { align: "right", className: "hidden @2xl:table-cell" })}
                    {th(t("invColUnitCost"), { column: "avg", align: "right" })}
                    {th(t("invColTotal"), { column: "value", align: "right" })}
                    {th(t("invColLastMovement"), { column: "moved", align: "right", className: "hidden @6xl:table-cell" })}
                    <th scope="col" className="w-12">
                      <span className="sr-only">{t("invColActions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {view.items.map((r) => {
                    const qty = r.stockLevel?.qtyBase ?? 0;
                    const cost = unitCost(r);
                    const state = reorderState(r);
                    return (
                      <tr key={r.id} className={"group" + (r.active ? "" : " is-archived")}>
                        <td className="mp-inv-sticky mp-inv-namecell">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="mp-inv-name truncate" title={r.category ? `${r.name} · ${r.category}` : r.name}>{r.name}</span>
                            {badges(r)}
                            {codesChip(r)}
                            {/* Sin columna de categoría (tarjeta angosta), va al final de la
                                línea y es lo primero que se recorta: el nombre manda. */}
                            <span className="@4xl:hidden ml-auto min-w-0 shrink-[1000] truncate pl-1 text-xs text-op-muted">{r.category ?? t("noCategory")}</span>
                          </div>
                        </td>
                        <td className="hidden @4xl:table-cell text-op-muted">
                          <span className="block max-w-[14rem] truncate" title={r.category ?? undefined}>{r.category ?? t("noCategory")}</span>
                        </td>
                        <td className={"text-right tabular-nums font-medium" + (qty < 0 ? " text-danger" : state === "low" ? " mp-inv-lowtext" : "")}>
                          {qtyText(r, qty)}
                        </td>
                        <td className="hidden @2xl:table-cell text-right tabular-nums text-op-muted">
                          {r.reorderPointBase != null ? qtyText(r, r.reorderPointBase) : "—"}
                        </td>
                        <td className="text-right tabular-nums text-op-muted">
                          {cost ? `${money(cost.cents)}/${cost.symbol}` : "—"}
                        </td>
                        <td className="text-right tabular-nums font-medium">{money(r.stockLevel?.totalValueCents ?? 0)}</td>
                        <td className="hidden @6xl:table-cell text-right tabular-nums text-op-muted">
                          {r.stockLevel ? formatDate(r.stockLevel.updatedAt, { locale, ...SHORT_DATE }) : t("noMovementYet")}
                        </td>
                        <td className="text-right">
                          <RowActionsMenu label={t("rowActionsLabel", { name: r.name })} items={menuItems(r)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Celular: tarjeta compacta por insumo. */}
            <ul className="md:hidden divide-y divide-op-border">
              {view.items.map((r) => {
                const qty = r.stockLevel?.qtyBase ?? 0;
                const state = reorderState(r);
                const codes = ingredientBarcodeValues(r).length;
                const sub = [
                  r.category ?? t("noCategory"),
                  r.reorderPointBase != null && r.active ? t("reorderMinRef", { qty: qtyText(r, r.reorderPointBase) }) : null,
                ].filter(Boolean).join(" · ");
                return (
                  <li key={r.id} className={"flex items-center gap-2 py-2 pl-4 pr-1" + (r.active ? "" : " is-archived")}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="mp-inv-name truncate text-sm">{r.name}</span>
                        {badges(r, true)}
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-op-muted min-w-0">
                        <span className="truncate">{sub}</span>
                        {codes > 0 && (
                          <span className="inline-flex items-center gap-0.5 shrink-0 tabular-nums" title={t("barcodeCountLabel", { count: codes })}>
                            <InvIcon name="barcode" size={12} />
                            <span className="sr-only">{t("barcodeCountLabel", { count: codes })}</span>
                            <span aria-hidden>{codes}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={"text-sm font-medium tabular-nums" + (qty < 0 ? " text-danger" : state === "low" ? " mp-inv-lowtext" : "")}>
                        {qtyText(r, qty)}
                      </div>
                      <div className="mt-0.5 text-xs text-op-muted tabular-nums">{money(r.stockLevel?.totalValueCents ?? 0)}</div>
                    </div>
                    <RowActionsMenu label={t("rowActionsLabel", { name: r.name })} items={menuItems(r)} />
                  </li>
                );
              })}
            </ul>

            {view.pageCount > 1 && (
              <nav className="mp-pager" aria-label={t("paginationLabel")}>
                <span className="mp-pager__info">{t("paginationShowing", { from: view.from, to: view.to, total: view.total })}</span>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => goTo(view.page - 1)} disabled={view.page <= 1} className="mp-btn mp-btn--secondary mp-btn--sm">
                    <InvIcon name="chevronLeft" />
                    {t("paginationPrev")}
                  </button>
                  <span className="text-xs text-op-muted tabular-nums">{t("paginationPage", { page: view.page, pages: view.pageCount })}</span>
                  <button type="button" onClick={() => goTo(view.page + 1)} disabled={view.page >= view.pageCount} className="mp-btn mp-btn--secondary mp-btn--sm">
                    {t("paginationNext")}
                    <InvIcon name="chevronRight" />
                  </button>
                </div>
              </nav>
            )}
          </>
        )}
      </div>
    </div>
  );
}
