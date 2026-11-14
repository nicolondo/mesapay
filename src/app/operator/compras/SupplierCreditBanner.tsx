import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { creditNoteListHref } from "@/lib/erp/supplierCreditNoteList";

/**
 * «Por pagar» de Compras: saldo a favor de los proveedores (notas crédito
 * sin cruzar). Es plata a favor del comercio, no deuda negativa: va aparte,
 * con el enlace a las notas con saldo para aplicarlas o pedir el reintegro.
 */
export async function SupplierCreditBanner({
  totalCents,
  suppliers,
  supplierId,
  currency,
}: {
  totalCents: number;
  suppliers: number;
  supplierId: string | null;
  currency: string;
}) {
  const t = await getTranslations("opSupplierCredit");
  const locale = (await getLocale()) as Locale;
  return (
    <div role="status" className="mb-4 rounded-2xl border border-[#2F6B4F]/30 bg-[#2F6B4F]/8 px-4 py-3 flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{t("unpaidBannerTitle", { amount: formatMoney(totalCents, { currency, locale, fractionDigits: "auto" }) })}</div>
        <div className="text-[12px] text-op-muted">{t("unpaidBannerBody", { n: suppliers })}</div>
      </div>
      <Link href={creditNoteListHref({ supplier: supplierId ?? "", status: "with_balance" })} className="mp-btn mp-btn--secondary mp-btn--sm">
        {t("seeNotes")}
      </Link>
    </div>
  );
}
