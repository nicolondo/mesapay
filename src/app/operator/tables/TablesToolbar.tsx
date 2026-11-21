"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Icon } from "@/components/ui/Icon";
import type { SalonView } from "./SalonMap";

export type TableFilter = "all" | "by_pay" | "recent" | "free";

/** Separa la vista, los estados del salón y la facturación. La gestión
 * ocasional se despliega en línea, sin tapar las mesas ni duplicar controles. */
export function TablesToolbar({
  filter, counts, onFilterChange, view, onViewChange, canMap,
  canManage, editMode, onEditModeChange, tableManagement,
  canOpenManual, manualPendingCount, openingManual, onOpenManual,
}: {
  filter: TableFilter;
  counts: Record<TableFilter, number>;
  onFilterChange: (filter: TableFilter) => void;
  view: SalonView;
  onViewChange: (view: SalonView) => void;
  canMap: boolean;
  canManage: boolean;
  editMode: boolean;
  onEditModeChange: (editing: boolean) => void;
  tableManagement?: ReactNode;
  canOpenManual: boolean;
  manualPendingCount: number;
  openingManual: boolean;
  onOpenManual: () => void;
}) {
  const t = useTranslations("opTables");
  const [managementOpen, setManagementOpen] = useState(false);
  const managementId = useId();
  const managementButton = useRef<HTMLButtonElement>(null);

  function closeManagement(event: KeyboardEvent) {
    if (event.key !== "Escape" || !managementOpen) return;
    event.preventDefault();
    event.stopPropagation();
    setManagementOpen(false);
    managementButton.current?.focus();
  }

  return (
    <div className="mp-tables-toolbar">
      <div className="mp-tables-toolbar__filters" role="group" aria-label={t("filterLabel")}>
        {([
          ["all", "filterAll", undefined],
          ["by_pay", "filterByPay", "danger"],
          ["recent", "filterRecent", "ok"],
          ["free", "filterFree", undefined],
        ] as const).map(([value, label, tone]) => (
          <button key={value} type="button" aria-pressed={filter === value} data-tone={tone}
            onClick={() => onFilterChange(value)} className="mp-tables-filter">
            <span>{t(label)}</span>
            <span className="mp-tables-filter__count">{counts[value]}</span>
          </button>
        ))}
      </div>

      {(canManage || (canMap && !editMode)) && (
        <div className="mp-tables-toolbar__controls">
          {canMap && !editMode && (
            <div className="mp-seg mp-tables-toolbar__view" role="group" aria-label={t("viewLabel")}>
              <button type="button" aria-pressed={view === "cards"} data-active={view === "cards"}
                onClick={() => onViewChange("cards")} className="mp-seg__i">
                {t("viewCards")}
              </button>
              <button type="button" aria-pressed={view === "map"} data-active={view === "map"}
                onClick={() => onViewChange("map")} className="mp-seg__i">
                {t("viewMap")}
              </button>
            </div>
          )}
          {canManage && (
            <button
              ref={managementButton}
              type="button"
              aria-label={editMode ? t("editDone") : t("manageTables")}
              aria-expanded={editMode ? undefined : managementOpen}
              aria-controls={editMode ? undefined : managementId}
              onKeyDown={closeManagement}
              onClick={() => editMode ? onEditModeChange(false) : setManagementOpen(open => !open)}
              className={`mp-btn mp-tables-toolbar__manage ${editMode ? "mp-btn--primary" : "mp-btn--ghost"}`}
            >
              {!editMode && <Icon name="settings" width={16} height={16} />}
              {editMode ? t("editDone") : t("manage")}
              {!editMode && (
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"
                  className="mp-tables-toolbar__chevron" data-open={managementOpen}>
                  <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          )}
        </div>
      )}

      {canManage && (
        <div id={managementId} hidden={!managementOpen} onKeyDown={closeManagement}
          className="mp-tables-toolbar__management" role="group" aria-label={t("manageTables")}>
          <button type="button" className="mp-btn mp-btn--secondary mp-btn--sm"
            onClick={() => {
              onEditModeChange(true);
              setManagementOpen(false);
              managementButton.current?.focus();
            }}>
            {t("editTables")}
          </button>
          {tableManagement}
        </div>
      )}

      {canOpenManual && (
        <div className="mp-tables-toolbar__invoices" role="group" aria-label={t("manualInvoicesLabel")}>
          <button type="button" onClick={onOpenManual} disabled={openingManual}
            className="mp-btn mp-tables-toolbar__invoice-create">
            <Icon name="plus" width={16} height={16} />
            <span>{openingManual ? t("manualInvoiceOpening") : t("manualInvoiceButton")}</span>
          </button>
          {manualPendingCount > 0 && (
            <Link href="/operator/facturas-manuales" prefetch={false} className="mp-btn mp-btn--ghost"
              aria-label={`${t("manualPendingShort")} ${manualPendingCount}: ${t("manualInvoicesLabel")}`}>
              <span>{t("manualPendingShort")}</span>
              <span className="mp-tables-toolbar__pending-count">{manualPendingCount}</span>
              <Icon name="arrow" width={16} height={16} />
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
