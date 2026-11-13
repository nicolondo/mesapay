import { getTranslations } from "next-intl/server";
import { fmtCOP } from "@/lib/format";
import type { CreditSale } from "@/lib/orders/creditSale";

/**
 * Distintivo de una cuenta cobrada a crédito, junto a su estado («Pagado»):
 * «A crédito» (deuda del cliente en Cartera, no entró plata) o «Crédito
 * pagado» (el cliente ya la pagó). Borde y texto, no sólo color, para que
 * no se confunda con el estado de la cuenta. El `title` dice cuánto falta.
 * Ver src/lib/orders/creditSale.ts.
 */
export async function CreditSaleBadge({
  sale,
  size = "sm",
}: {
  sale: Pick<CreditSale, "status" | "outstandingCents">;
  size?: "sm" | "md";
}) {
  const t = await getTranslations("opOrders");
  const paid = sale.status === "credit_paid";
  const hint = paid
    ? t("creditPaidHint")
    : sale.outstandingCents > 0
      ? t("creditOwedHint", { amount: fmtCOP(sale.outstandingCents) })
      : t("creditNoBalanceHint");
  return (
    <span
      title={hint}
      className={
        "inline-flex items-center whitespace-nowrap rounded-full border font-medium " +
        (size === "md" ? "h-6 px-2 text-[11px] " : "h-5 px-2 text-[10px] ") +
        (paid
          ? "border-[#2E6B4C]/40 text-[#1E5339]"
          : "border-[#C98A2E]/60 bg-[#C98A2E]/10 text-[#8F6828]")
      }
    >
      {paid ? t("creditPaid") : t("creditOnCredit")}
      <span className="sr-only">{`. ${hint}`}</span>
    </span>
  );
}
