"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import { REFERENCE_PRICE_QTY_BASE, referencePriceUnit } from "@/lib/erp/ingredientPrice";
import type { IngredientCostView } from "@/lib/erp/recipeData";
import type { CostSource } from "@/lib/erp/recipes";
import type { PurchaseCostDateBasis } from "@/lib/erp/purchaseCost";
import type { MeasureKind } from "@/lib/erp/units";

const SOURCE_KEYS = {
  stock: "rdSourceStock",
  subrecipe: "rdSourceSubrecipe",
  reference: "rdSourceReference",
  purchase: "rdSourcePurchase",
  supplier: "rdSourceSupplier",
} as const satisfies Record<Exclude<CostSource, null>, string>;

const DATE_KEYS = {
  line_received: "ingredientPurchaseLineReceivedAt",
  order_received: "ingredientPurchaseReceivedAt",
  stock_movement: "ingredientPurchaseMovementAt",
  order_created: "ingredientPurchaseRecordedAt",
} as const satisfies Record<PurchaseCostDateBasis, string>;

/** The effective recipe cost is separate from the editable manual reference. */
export function IngredientCostSummary({ ingredient, currency, purchaseOpensNewTab = false }: {
  ingredient: { name: string; measureKind: MeasureKind } & Partial<IngredientCostView>;
  currency: string;
  purchaseOpensNewTab?: boolean;
}) {
  const t = useTranslations("opErp");
  const locale = useLocale() as Locale;
  const { costPerBase, costSource, purchaseCost } = ingredient;
  const price = typeof costPerBase === "number" ? Math.round(costPerBase * REFERENCE_PRICE_QTY_BASE) : null;
  const known = price !== null && Number.isSafeInteger(price) && price >= 0 && costSource != null;
  const purchase = known && costSource === "purchase" ? purchaseCost : null;

  return (
    <div role="group" aria-label={t("ingredientCostGroup", { name: ingredient.name })} className="min-w-0 space-y-1 text-xs">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-op-muted">{t("ingredientCostLabel")}</span>
        <span className="font-medium tabular-nums text-op-text">
          {known
            ? `${formatMoney(price, { currency, locale, fractionDigits: 2 })}/${referencePriceUnit(ingredient.measureKind)}`
            : t("ingredientCostMissing")}
        </span>
      </p>
      {known && <p className="text-op-muted">{t(SOURCE_KEYS[costSource])}</p>}
      {purchase && (
        <div className="space-y-0.5 break-words text-op-muted">
          <p>{t("ingredientPurchaseAverage")}</p>
          <p>
            <a
              href={`/operator/compras?oc=${encodeURIComponent(purchase.purchaseOrderId)}`}
              target={purchaseOpensNewTab ? "_blank" : undefined}
              rel={purchaseOpensNewTab ? "noopener noreferrer" : undefined}
              aria-label={purchaseOpensNewTab ? t("ingredientPurchaseOpenNewTab", {
                number: t("poNumber", { number: String(purchase.purchaseOrderNumber).padStart(4, "0") }),
              }) : undefined}
              className="font-medium text-op-text underline underline-offset-2 hover:no-underline"
            >
              {t("poNumber", { number: String(purchase.purchaseOrderNumber).padStart(4, "0") })}
            </a>
            {" · "}{purchase.supplierName}
          </p>
          <p>{t(DATE_KEYS[purchase.dateBasis], {
            date: formatDate(purchase.receivedAt, { locale, dateStyle: "long", timeStyle: undefined }),
          })}</p>
        </div>
      )}
    </div>
  );
}
