"use client";

import { useId, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import type {
  IngredientOption,
  ModifierGroupDto,
  ModLine,
} from "../recipeModel";
import type { LineView } from "./lineView";
import { LinesTable, type LinesCtl } from "./LinesTable";
import { LineCards } from "./LineCards";
import { ChevronIcon, WarningIcon } from "./icons";

/**
 * Insumos por opción de modificador (extra queso +, sin cebolla −): por cada
 * grupo del plato y cada opción, las mismas líneas que la receta base, con
 * el toggle agrega/quita. Solo cambian el consumo y el CMV cuando el
 * comensal elige esa opción; el costo de arriba es el de la receta base.
 */
export function ModifiersSection({
  modifiers,
  views,
  ctl,
  catalog,
  desktop,
  onAdd,
  onEdit,
  onAddMobile,
}: {
  modifiers: ModifierGroupDto[];
  views: LineView<ModLine>[];
  ctl: LinesCtl<ModLine>;
  catalog: readonly IngredientOption[];
  desktop: boolean;
  onAdd: (modifierId: string, optLabel: string, ing: IngredientOption) => void;
  onEdit: (key: number) => void;
  onAddMobile: (modifierId: string, optLabel: string) => void;
}) {
  const t = useTranslations("opErp");
  const headingId = useId();
  if (modifiers.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div>
        <h3 id={headingId} className="text-sm font-semibold">
          {t("modRecipeTitle")}
        </h3>
        <p className="text-[12px] text-op-muted mt-0.5">{t("modRecipeHint")}</p>
      </div>
      {modifiers.map((m) => (
        <div
          key={m.id}
          className="rounded-2xl border border-op-border bg-op-surface overflow-hidden"
        >
          <div className="px-4 py-2.5 bg-op-bg/60 border-b border-op-border text-sm font-medium">
            {m.label}
          </div>
          <div className="divide-y divide-op-border">
            {m.opts.map((opt) => (
              <OptionBlock
                key={opt}
                label={opt}
                views={views.filter(
                  (v) => v.line.modifierId === m.id && v.line.optLabel === opt,
                )}
                ctl={ctl}
                catalog={catalog}
                desktop={desktop}
                onAdd={(ing) => onAdd(m.id, opt, ing)}
                onEdit={onEdit}
                onAddMobile={() => onAddMobile(m.id, opt)}
              />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function OptionBlock({
  label,
  views,
  ctl,
  catalog,
  desktop,
  onAdd,
  onEdit,
  onAddMobile,
}: {
  label: string;
  views: LineView<ModLine>[];
  ctl: LinesCtl<ModLine>;
  catalog: readonly IngredientOption[];
  desktop: boolean;
  onAdd: (ing: IngredientOption) => void;
  onEdit: (key: number) => void;
  onAddMobile: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const panelId = useId();
  const [open, setOpen] = useState(views.length > 0);
  const used = useMemo(
    () => new Set(views.map((v) => v.line.ingredientId)),
    [views],
  );
  const addOptions = useMemo(
    () => catalog.filter((i) => !used.has(i.id)),
    [catalog, used],
  );

  // Diferencia de costo de la opción (con signo); parcial si falta alguno.
  let delta = 0;
  let missing = 0;
  for (const v of views) {
    if (v.lineCost != null) delta += v.lineCost;
    if (v.state === "none") missing++;
  }
  const deltaLabel =
    views.length === 0
      ? null
      : `${delta > 0 ? "+" : delta < 0 ? "−" : ""}${formatMoney(Math.abs(delta), {
          currency: ctl.currency,
          locale,
        })}`;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full min-h-[44px] px-4 py-2 flex items-center gap-2 text-left hover:bg-op-bg/60"
      >
        <ChevronIcon open={open} size={14} className="text-op-muted" />
        <span className="flex-1 min-w-0 text-sm truncate">{label}</span>
        {missing > 0 && <WarningIcon size={13} className="text-[#7F5A1F]" />}
        <span className="text-[12px] text-op-muted tabular-nums shrink-0">
          {views.length > 0
            ? `${t("modOptLineCount", { count: views.length })} · ${deltaLabel}`
            : t("modOptAdd")}
        </span>
      </button>
      {open && (
        <div id={panelId} className={desktop ? "px-2 pb-2" : "px-4 pb-3 space-y-2"}>
          {desktop ? (
            <LinesTable
              signed
              views={views}
              ctl={ctl}
              addOptions={addOptions}
              onAdd={onAdd}
              addPlaceholder={t("rdAddToOption", { option: label })}
            />
          ) : (
            <>
              <LineCards signed views={views} ctl={ctl} onEdit={onEdit} />
              <button
                type="button"
                onClick={onAddMobile}
                className="mp-btn mp-btn--secondary mp-btn--sm mp-btn--block"
              >
                {t("rdAddIngredient")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
