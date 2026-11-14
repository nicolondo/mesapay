import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CREDIT_NOTES_PATH } from "@/lib/erp/supplierCreditNoteList";

/**
 * Pestañas de las páginas de Notas crédito y Pagos (Órdenes · Por pagar ·
 * Notas crédito · Pagos). La lista de compras pinta las suyas (con sus filtros); éstas
 * enlazan a sus URLs limpias.
 */
export async function ComprasTabs({ active }: { active: "credit_notes" | "payments" }) {
  const t = await getTranslations("opErp");
  const tc = await getTranslations("opSupplierCredit");
  const tp = await getTranslations("opSupplierPayment");
  const items = [
    { key: "orders", href: "/operator/compras", label: t("tabOrders") },
    { key: "unpaid", href: "/operator/compras?tab=unpaid", label: t("tabUnpaid") },
    { key: "credit_notes", href: CREDIT_NOTES_PATH, label: tc("tabCreditNotes") },
    { key: "payments", href: "/operator/compras/pagos", label: tp("tabPayments") },
  ];
  return (
    <nav aria-label={t("plTabsLabel")} className="mb-4">
      <div className="mp-seg w-full sm:w-auto">
        {items.map((it) => (
          <Link
            key={it.key}
            href={it.href}
            prefetch={false}
            aria-current={active === it.key ? "page" : undefined}
            data-active={active === it.key ? "true" : undefined}
            className="mp-seg__i flex-1 sm:flex-none justify-center"
          >
            {it.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
