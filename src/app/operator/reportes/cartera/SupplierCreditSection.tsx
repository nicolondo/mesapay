import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { SupplierCreditBalance } from "@/lib/erp/reports/supplierCreditCartera";
import { creditNoteListHref } from "@/lib/erp/supplierCreditNoteList";
import { CardFacts, CardTotal, ReportCards, ReportTable } from "../_components/ReportCards";

const TH = "px-3 py-2 font-mono text-[9px] uppercase tracking-wider font-normal";
const NUM = "px-3 py-2 text-right font-mono tabular whitespace-nowrap";

/**
 * Saldos a favor de proveedores (notas crédito sin cruzar): un DERECHO del
 * comercio, aparte de lo que se debe. Cada fila abre las notas con saldo de
 * ese proveedor, donde se aplican a una factura o se registra el reintegro.
 */
export async function SupplierCreditSection({
  balances,
  asOf,
  money,
}: {
  balances: SupplierCreditBalance[];
  asOf: string;
  money: (c: number) => string;
}) {
  const t = await getTranslations("opSupplierCredit");
  const tc = await getTranslations("opCartera");
  const total = balances.reduce((s, b) => s + b.availableCents, 0);
  const href = (supplierId: string) => creditNoteListHref({ supplier: supplierId, status: "with_balance", to: asOf });
  return (
    <section className="min-w-0 space-y-2">
      <h2 className="text-[11px] uppercase tracking-wider text-op-muted">{t("carteraSectionTitle")}</h2>
      <p className="text-xs text-op-muted max-w-2xl">{t("carteraSectionHint")}</p>
      <div className="min-w-0 overflow-hidden rounded-2xl border border-op-border bg-op-surface">
        <ReportTable>
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="border-b border-op-border text-op-muted">
                <th className={`${TH} text-left`}>{tc("colPartner")}</th>
                <th className={`${TH} text-left`}>{tc("colTaxId")}</th>
                <th className={`${TH} text-right`}>{t("colNotes")}</th>
                <th className={`${TH} text-right`}>{t("balanceLabel")}</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.supplierId} className="border-b border-op-border/60 last:border-b-0">
                  <td className="px-3 py-2 min-w-0">
                    <Link href={href(b.supplierId)} className="font-medium hover:underline">
                      {b.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-op-muted whitespace-nowrap">{b.taxId ?? "—"}</td>
                  <td className={NUM}>{b.notes}</td>
                  <td className={`${NUM} font-semibold`}>{money(b.availableCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
                <td className="px-3 py-2" colSpan={3}>
                  {t("carteraTotal")}
                </td>
                <td className={NUM}>{money(total)}</td>
              </tr>
            </tfoot>
          </table>
        </ReportTable>
        <ReportCards>
          {balances.map((b) => (
            <div key={b.supplierId} className="px-3 py-2.5">
              <Link href={href(b.supplierId)} className="break-words font-medium hover:underline">
                {b.name}
              </Link>
              {b.taxId && <div className="font-mono text-xs text-op-muted">{b.taxId}</div>}
              <CardFacts
                className="mt-1.5"
                items={[
                  { label: t("colNotes"), value: b.notes },
                  { label: t("balanceLabel"), value: money(b.availableCents), strong: true },
                ]}
              />
            </div>
          ))}
          <CardTotal label={t("carteraTotal")} items={[{ label: t("balanceLabel"), value: money(total) }]} />
        </ReportCards>
      </div>
    </section>
  );
}
