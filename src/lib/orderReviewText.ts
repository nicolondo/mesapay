import type { OrderReviewView } from "./orderReview";

/**
 * Textos del aviso «Revisar» (namespace `orderReview` de los catálogos),
 * iguales en la ficha de la mesa, el cobro, la carta del personal y el push
 * a los meseros. Puro: recibe la función de traducción (`useTranslations` o
 * `getTranslations`) y cómo formatear la hora (`@/lib/format`).
 */
type Translate = (key: string, values?: Record<string, string | number>) => string;

export function orderReviewLines(
  view: OrderReviewView,
  t: Translate,
  fmtTime: (iso: string) => string,
): string[] {
  const lines: string[] = [];
  if (view.flags.includes("stale_customer_discount") && view.customerName) {
    lines.push(
      t("staleCustomerDiscount", {
        name: view.customerName,
        pct: view.discountPct ?? 0,
        time: fmtTime(view.discountAppliedAt ?? view.openedAt),
      }),
    );
  }
  const failed = view.flags.includes("failed_charge_still_open");
  if (failed || view.flags.includes("long_idle_reopened")) {
    lines.push(
      t(failed ? "openSinceDeclined" : "openSince", { time: fmtTime(view.openedAt) }),
    );
  }
  return lines;
}

/** El descuento de la cuenta lo puso un cliente de facturación (se puede quitar). */
export function reviewHasCustomerDiscount(view: OrderReviewView | null): boolean {
  return !!view?.flags.includes("stale_customer_discount");
}
