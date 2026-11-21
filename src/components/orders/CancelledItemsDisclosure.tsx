import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney } from "@/lib/format";
import type { CancelledItemView } from "@/lib/orders/cancelledItems";

/**
 * Desplegable «Platos cancelados (N)», cerrado por defecto: un renglón por
 * plato que salió de la cuenta, con su valor, la hora, quién lo canceló, el
 * motivo y si fue cancelado, no cobrado o cayó con su ronda. Sólo
 * informativo: el valor va tachado y no se suma a ningún total.
 *
 * Sin estado propio (`<details>` nativo) para servir igual en el detalle de la
 * orden (componente de servidor) y en la ficha de la mesa (cliente). Con
 * N = 0 no pinta nada.
 */
export function CancelledItemsDisclosure({
  items,
  currency,
  className = "",
}: {
  items: CancelledItemView[];
  currency: string;
  className?: string;
}) {
  const t = useTranslations("cancelledItems");
  const locale = useLocale() as Locale;
  if (items.length === 0) return null;

  return (
    <details
      data-testid="cancelled-items"
      className={`group overflow-hidden rounded-xl border border-op-border bg-op-surface ${className}`}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <span className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted">
          {t("summary", { count: items.length })}
        </span>
        <span aria-hidden className="text-xs text-op-muted transition-transform group-open:rotate-180">
          {"▾"}
        </span>
      </summary>
      <ul className="divide-y divide-op-border border-t border-op-border">
        {items.map((item) => {
          const kind =
            item.kind === "round"
              ? t("kindRound", { seq: item.roundSeq ?? 0 })
              : item.kind === "comp"
                ? t("kindComp")
                : t("kindCancel");
          const actor =
            item.actor.type === "staff"
              ? t("by", { name: item.actor.name })
              : item.actor.type === "email"
                ? t("by", { name: item.actor.email })
                : t("byUnknown");
          return (
            <li key={item.id} data-testid="cancelled-item" className="px-3 py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 font-mono tabular text-op-muted">
                  {item.qty}
                  {"×"}
                </span>
                <span className="min-w-0 flex-1 break-words text-sm">{item.name}</span>
                <span
                  className="shrink-0 font-mono tabular text-sm text-op-muted line-through"
                  title={t("notCounted")}
                >
                  {formatMoney(item.amountCents, { currency, locale, fractionDigits: "auto" })}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-op-muted">
                <span className="rounded-full border border-op-border px-2 py-0.5 font-mono text-[10px] tracking-wider uppercase">
                  {kind}
                </span>
                {item.cancelledAt ? (
                  <time dateTime={item.cancelledAt}>
                    {formatDate(item.cancelledAt, { locale, dateStyle: undefined, timeStyle: "short" })}
                  </time>
                ) : (
                  <span>{t("timeUnknown")}</span>
                )}
                <span aria-hidden>{"·"}</span>
                <span
                  className="min-w-0 [overflow-wrap:anywhere]"
                  title={item.actor.type === "staff" ? item.actor.email : undefined}
                >
                  {actor}
                </span>
              </div>
              {item.reason && (
                <p className="mt-1 whitespace-pre-wrap break-words text-xs text-op-muted">
                  {t("reason", { reason: item.reason })}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="border-t border-op-border px-3 py-2 text-[11px] text-op-muted">
        {t("notCounted")}
      </p>
    </details>
  );
}
