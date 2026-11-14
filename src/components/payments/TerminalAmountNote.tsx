"use client";

import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import type { TerminalAmountView } from "@/lib/payments/terminalAmount";

/**
 * El datáfono Kushki aprobó otro monto que el de la cuenta (ver
 * terminalAmount.ts). Lo dice en una línea:
 *
 *   - `full`: el aviso completo (ficha, «Mesas en vivo», detalle de la orden);
 *   - `short`: la etiqueta corta (filas de Cobros).
 *
 * Propina y parcial ya están liquidados (con revisión pendiente); «monto
 * cobrado distinto» sigue por resolver.
 */
export function TerminalAmountNote({
  amount,
  currency = "COP",
  variant = "full",
  tone = "auto",
  className = "",
}: {
  amount: TerminalAmountView;
  currency?: string;
  variant?: "full" | "short";
  /** `inherit`: toma el color del contenedor (p. ej. el recuadro de «Pagada»). */
  tone?: "auto" | "inherit";
  className?: string;
}) {
  const t = useTranslations("terminalAttempt");
  const locale = useLocale() as Locale;
  const money = (cents: number) => formatMoney(cents, { locale, currency, fractionDigits: cents % 100 ? 2 : 0 });
  const text = terminalAmountText(amount, variant, t, money);
  const color =
    tone === "inherit"
      ? ""
      : amount.check === "tip"
        ? "text-op-muted"
        : amount.check === "partial"
          ? "text-terracotta"
          : "text-danger";
  return <p className={`text-[11px] leading-snug ${color} ${className}`}>{text}</p>;
}

type Translate = (key: string, values?: Record<string, string>) => string;

/** El texto del aviso (también para los resultados que se muestran como mensaje). */
export function terminalAmountText(
  amount: TerminalAmountView,
  variant: "full" | "short",
  t: Translate,
  money: (cents: number) => string,
): string {
  const { check, expectedCents, authorizedCents } = amount;
  const expected = money(expectedCents);
  if (authorizedCents != null && check === "tip") {
    const extra = money(authorizedCents - expectedCents);
    return variant === "short"
      ? t("amountTipShort", { amount: extra })
      : `${t("amountTipNote", { extra, authorized: money(authorizedCents) })} ${t("amountReviewNote")}`;
  }
  if (authorizedCents != null && check === "partial") {
    const missing = money(expectedCents - authorizedCents);
    return variant === "short"
      ? t("amountPartialShort", { amount: missing })
      : t("amountPartialNote", { authorized: money(authorizedCents), expected, missing });
  }
  if (authorizedCents == null) {
    return variant === "short" ? t("amountMismatchShortUnknown") : t("amountMismatchUnknownBody");
  }
  const authorized = money(authorizedCents);
  if (variant === "short") return t("amountMismatchShort", { authorized, expected });
  if (check === "units") return t("amountMismatchUnitsBody", { authorized, expected });
  if (check === "unconfirmed") return t("amountMismatchUnconfirmedBody", { authorized, expected });
  return t("amountMismatchBody", { authorized, expected });
}

/** Lo que devuelve `terminal/charge` cuando aprobó otro monto. */
export type TerminalChargeAdjustment = {
  check: "tip" | "partial";
  expectedCents: number;
  authorizedCents: number;
  diffCents: number;
};

/** El adjustment de la respuesta de `terminal/charge`, si es legible. */
function chargeAdjustment(json: { adjustment?: unknown }): TerminalChargeAdjustment | null {
  const a = json.adjustment as Partial<TerminalChargeAdjustment> | null | undefined;
  if (!a || typeof a !== "object") return null;
  if ((a.check !== "tip" && a.check !== "partial") || typeof a.expectedCents !== "number" || typeof a.authorizedCents !== "number") {
    return null;
  }
  return a as TerminalChargeAdjustment;
}

/**
 * Lo que dijo `terminal/charge` sobre el monto, como aviso completo (sin la
 * mesa): null si autorizó lo de la cuenta.
 */
export function terminalChargeResponseText(
  json: { adjustment?: unknown; terminal?: unknown },
  t: Translate,
  money: (cents: number) => string,
): string | null {
  if (json.terminal === "amount_mismatch") return t("checkAmountMismatch");
  const a = chargeAdjustment(json);
  if (!a) return null;
  return terminalAmountText({ check: a.check, expectedCents: a.expectedCents, authorizedCents: a.authorizedCents }, "full", t, money);
}

/**
 * El mensaje para quien acaba de cobrar («Mesas en vivo», Salón): la mesa y
 * qué pasó con el monto. null si autorizó lo de la cuenta.
 */
export function terminalChargeOutcomeText(
  json: { adjustment?: unknown; terminal?: unknown },
  place: string,
  t: Translate,
  money: (cents: number) => string,
): string | null {
  if (json.terminal === "amount_mismatch") return t("amountMismatchOutcome", { place });
  const a = chargeAdjustment(json);
  if (!a) return null;
  if (a.check === "tip") return t("amountTipOutcome", { place, extra: money(a.authorizedCents - a.expectedCents) });
  if (a.check === "partial") {
    return t("amountPartialOutcome", {
      place,
      authorized: money(a.authorizedCents),
      missing: money(a.expectedCents - a.authorizedCents),
    });
  }
  return null;
}
