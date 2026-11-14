"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { AppDialog } from "@/components/ui/AppDialog";
import { Icon } from "@/components/ui/Icon";
import { DiscountControl } from "../DiscountControl";
import { IngredientPicker } from "./IngredientPicker";
import { DiscountCaption, PriceInput, QtyInput, TaxSelect, TotalInput, UnitSelect, usePriceSourceText } from "./cells";
import { DupIcon } from "./LinesTable";
import {
  effectiveUnitCents,
  hasIssues,
  lineIssues,
  lineListCents,
  PRES,
  priceUnitSymbol,
  type OcLine,
} from "./draft";
import { ISSUE_KEYS, issueId, type LineCtl } from "./lineCtl";

/**
 * Productos en el celular: una tarjeta de dos renglones por producto
 * (insumo y total; cantidad × precio con su impuesto y descuento). Tocarla
 * abre la hoja de edición.
 */
export function LineCards({
  lines,
  ctl,
  onEdit,
}: {
  lines: OcLine[];
  ctl: LineCtl;
  onEdit: (key: number) => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const money = (c: number) => formatMoney(c, { currency: ctl.currency, locale, fractionDigits: "auto" });
  const shown = lines.filter((l) => l.ingredient);
  if (shown.length === 0) return null;
  return (
    <ul className="rounded-2xl border border-op-border bg-op-surface overflow-hidden divide-y divide-op-border" data-testid="oc-line-cards">
      {shown.map((l) => {
        const list = lineListCents(l);
        const amounts = ctl.amounts(l.key);
        const net = list != null ? list - (amounts?.lineDiscountCents ?? 0) : null;
        const unitCents = effectiveUnitCents(l);
        const bad = hasIssues(lineIssues(l));
        const kind = l.ingredient!.measureKind;
        const qty =
          l.unit === PRES && l.supplierItem
            ? t("ocCardQtyPres", { qty: l.qtyRaw || "0", presentation: l.supplierItem.presentationLabel })
            : `${l.qtyRaw || "0"} ${l.unit}`;
        const price =
          unitCents == null
            ? null
            : l.unit === PRES
              ? t("ocCardPriceEach", { price: money(unitCents) })
              : t("ocPricePer", { price: money(unitCents), unit: priceUnitSymbol(kind) });
        const chips = [
          l.tax.ivaPct > 0 ? t("poTaxIva", { pct: l.tax.ivaPct }) : null,
          l.tax.inc ? t("ocIncShort") : null,
          amounts && amounts.lineDiscountCents > 0 ? `− ${money(amounts.lineDiscountCents)}` : null,
        ].filter(Boolean);
        const dup = l.dupDismissed ? null : ctl.duplicateOf(l);
        return (
          <li key={l.key}>
            <button
              type="button"
              onClick={() => onEdit(l.key)}
              aria-label={t("ocEditLine", { name: l.ingredient!.name })}
              className="w-full text-left px-4 py-3 flex items-start gap-3 active:bg-op-bg"
            >
              <span className="flex-1 min-w-0">
                <span className="block text-[15px] font-medium leading-snug truncate">{l.ingredient!.name}</span>
                <span className="block text-xs text-op-muted mt-0.5 truncate tabular-nums">
                  {[price ? `${qty} × ${price}` : qty, ...chips].join(" · ")}
                </span>
                {dup && (
                  <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-op-text bg-warn/15 rounded px-1.5 py-0.5">
                    <DupIcon />
                    {t("ocDupNotice", { name: l.ingredient!.name, n: dup.index + 1 })}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-[15px] font-medium tabular-nums">{net != null ? money(net) : t("ocNoPrice")}</span>
                {bad && <span className="block text-[11px] font-medium text-danger mt-0.5">{t("ocCheckLine")}</span>}
              </span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 mt-1 text-op-muted">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Hoja para agregar o editar UN producto en el celular. Al agregar, abre con
 * el buscador de insumos listo para escribir; al elegir, aparecen cantidad,
 * unidad, precio (precargado), descuento e impuesto, con el foco en la
 * cantidad. «Agregar otro» guarda y vuelve a abrir el buscador.
 */
export function LineEditorSheet({
  line,
  index,
  isNew,
  ctl,
  onClose,
  onAddAnother,
}: {
  line: OcLine;
  index: number;
  isNew: boolean;
  ctl: LineCtl;
  onClose: () => void;
  onAddAnother: () => void;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const sourceText = usePriceSourceText();
  const l = line;
  const issues = ctl.visibleIssues(l);
  const amounts = ctl.amounts(l.key);
  const dup = l.dupDismissed ? null : ctl.duplicateOf(l);
  const fieldLabel = "font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-1 block";
  const err = (col: "item" | "qty" | "price") =>
    issues[col] ? (
      <p id={issueId(l.key, col)} role="alert" className="mt-1 text-xs text-danger">
        {t(ISSUE_KEYS[issues[col]!])}
      </p>
    ) : null;

  return (
    <AppDialog label={isNew ? t("ocAddProduct") : t("ocLineEditorTitle")} onClose={onClose} dismissOnBackdrop={false} className="mp-sheet mp-sheet--md-center">
      <div className="flex flex-col max-h-[85dvh]">
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2 shrink-0">
          <h3 className="font-display text-xl">{isNew ? t("ocAddProduct") : t("ocLineEditorTitle")}</h3>
          <button type="button" onClick={onClose} aria-label={t("ocCloseEditor")} className="mp-icobtn -mr-2">
            <Icon name="close" width={18} height={18} />
          </button>
        </div>
        <div className="px-5 pb-4 overflow-y-auto overscroll-contain space-y-4">
          <div>
            <span className={fieldLabel}>{t("fieldIngredient")}</span>
            <IngredientPicker
              key={`${l.key}:${l.ingredient?.id ?? "new"}`}
              options={ctl.options}
              value={l.ingredient}
              currency={ctl.currency}
              autoFocus={!l.ingredient}
              onPick={(o) => ctl.pick(l.key, o)}
              onCreate={(text) => ctl.createIngredient(l.key, text)}
              ariaLabel={t("fieldIngredient")}
              ariaInvalid={issues.item != null}
              ariaDescribedBy={issues.item ? issueId(l.key, "item") : undefined}
            />
            {err("item")}
            {dup && (
              <div className="mt-2 rounded-lg bg-warn/15 px-3 py-2 text-xs text-op-text space-y-2">
                <p className="flex items-center gap-1.5">
                  <DupIcon />
                  {t("ocDupNotice", { name: l.ingredient?.name ?? "", n: dup.index + 1 })}
                </p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => ctl.merge(dup.line.key, l.key)} className="mp-btn mp-btn--sm mp-btn--secondary">
                    {t("ocDupMerge", { n: dup.index + 1 })}
                  </button>
                  <button type="button" onClick={() => ctl.patch(l.key, { dupDismissed: true })} className="mp-btn mp-btn--sm mp-btn--ghost">
                    {t("ocDupKeep")}
                  </button>
                </div>
              </div>
            )}
          </div>

          {l.ingredient && (
            <>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-3">
                <div>
                  <label htmlFor={`oc-m-qty-${l.key}`} className={fieldLabel}>{t("fieldQty")}</label>
                  <QtyInput
                    id={`oc-m-qty-${l.key}`}
                    line={l}
                    variant="field"
                    onChange={(qtyRaw) => ctl.patch(l.key, { qtyRaw })}
                    onBlur={() => ctl.touch(l.key, "qty")}
                    ariaLabel={t("fieldQty")}
                    invalid={issues.qty != null}
                    describedBy={issues.qty ? issueId(l.key, "qty") : undefined}
                  />
                  {err("qty")}
                </div>
                <div>
                  <label htmlFor={`oc-m-unit-${l.key}`} className={fieldLabel}>{t("ocColUnit")}</label>
                  <UnitSelect id={`oc-m-unit-${l.key}`} line={l} variant="field" onChange={(u) => ctl.setUnit(l.key, u)} ariaLabel={t("ocColUnit")} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor={`oc-m-price-${l.key}`} className={fieldLabel}>{t("ocColPrice")}</label>
                  <PriceInput
                    id={`oc-m-price-${l.key}`}
                    line={l}
                    variant="field"
                    onChange={(priceRaw) => ctl.patch(l.key, { priceRaw, totalRaw: null, priceSource: null })}
                    onBlur={() => ctl.touch(l.key, "price")}
                    ariaLabel={t("ocColPrice")}
                    invalid={issues.price != null}
                    describedBy={issues.price ? issueId(l.key, "price") : undefined}
                  />
                  {err("price")}
                  {!issues.price && sourceText(l.priceSource) && (
                    <p className="mt-1 text-[11px] text-op-muted">{sourceText(l.priceSource)}</p>
                  )}
                </div>
                <div>
                  <label htmlFor={`oc-m-total-${l.key}`} className={fieldLabel}>{t("totalLabel")}</label>
                  <TotalInput
                    id={`oc-m-total-${l.key}`}
                    line={l}
                    variant="field"
                    onChange={(totalRaw) => ctl.patch(l.key, { totalRaw })}
                    onRecalc={() => ctl.patch(l.key, { totalRaw: null })}
                    onBlur={() => ctl.touch(l.key, "price")}
                    ariaLabel={t("totalLabel")}
                  />
                  {l.totalRaw != null && <p className="mt-1 text-[11px] text-op-muted">{t("ocPriceFromTotal")}</p>}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">{t("discountLabel")}</span>
                <span className="text-right">
                  <DiscountControl
                    inline
                    label={t("discountLabel")}
                    raw={l.discRaw}
                    isPct={l.discIsPct}
                    currency={ctl.currency}
                    onChange={(discRaw, discIsPct) => ctl.patch(l.key, { discRaw, discIsPct })}
                  />
                  <DiscountCaption cents={amounts?.lineDiscountCents ?? 0} currency={ctl.currency} />
                </span>
              </div>
              <div>
                <label htmlFor={`oc-m-tax-${l.key}`} className={fieldLabel}>{t("poTaxLabel")}</label>
                <TaxSelect
                  id={`oc-m-tax-${l.key}`}
                  choice={l.tax}
                  rates={ctl.taxRates}
                  variant="field"
                  onChange={(c) => ctl.setTax(l.key, c)}
                  ariaLabel={t("poTaxLabel")}
                />
                {l.tax.inc && (
                  <DiscountControl
                    id={`oc-m-inc-${l.key}`}
                    label={t("poTaxIncLabel")}
                    raw={l.incRaw}
                    isPct={l.incIsPct}
                    currency={ctl.currency}
                    placeholder="0"
                    onChange={(incRaw, incIsPct) => ctl.patch(l.key, { incRaw, incIsPct })}
                    hint={
                      amounts && amounts.incCents > 0
                        ? t("poTaxIncResult", { amount: formatMoney(amounts.incCents, { currency: ctl.currency, locale, fractionDigits: "auto" }) })
                        : t("poTaxIncHint")
                    }
                    className="mt-2 rounded-xl border border-op-border bg-op-surface px-3 py-2"
                  />
                )}
              </div>
            </>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2 px-5 py-3 border-t border-op-border pb-[max(12px,env(safe-area-inset-bottom))]">
          {!isNew && (
            <button
              type="button"
              onClick={() => {
                ctl.remove(l.key);
                onClose();
              }}
              className="mp-btn mp-btn--danger"
            >
              {t("ocRemoveLine", { n: index + 1 })}
            </button>
          )}
          <span className="flex-1" />
          {isNew && l.ingredient && (
            <button type="button" onClick={onAddAnother} className="mp-btn mp-btn--secondary">
              {t("ocAddAnother")}
            </button>
          )}
          <button type="button" onClick={onClose} className="mp-btn mp-btn--primary" disabled={isNew && !l.ingredient}>
            {t("ocDone")}
          </button>
        </div>
      </div>
    </AppDialog>
  );
}
