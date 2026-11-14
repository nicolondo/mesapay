import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { formatDate, formatMoney } from "@/lib/format";
import { isModuleEnabled } from "@/lib/modules";
import { isSupplierPaymentMethod, voucherNumberLabel } from "@/lib/erp/supplierPaymentPlan";
import { loadSupplierPaymentDetail } from "@/lib/erp/supplierPaymentQueries";
import { PrintButton } from "../../../reportes/_components/PrintButton";
import { docLabel } from "../../notas-credito/docLabel";
import { VoidVoucher } from "./VoidVoucher";

export const dynamic = "force-dynamic";

/**
 * Comprobante de egreso (imprimible / «Guardar como PDF» del navegador) para
 * enviarle al proveedor: qué facturas se pagaron, con qué notas crédito y
 * anticipos se cruzaron, cuánto dinero salió y de qué cuenta. Desde aquí se
 * anula (con reverso).
 */
export default async function VoucherPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [t, tc, tSettings, locale] = await Promise.all([
    getTranslations("opSupplierPayment"),
    getTranslations("opSupplierCredit"),
    getTranslations("opSettings"),
    getLocale(),
  ]);
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{tSettings("noRestaurant")}</div>;
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true, country: true, name: true, legalName: true, taxId: true },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "purchasing")) notFound();
  const p = await loadSupplierPaymentDetail(restaurantId, id);
  if (!p) notFound();
  const currency = await getCurrencyForCountry(tenant.country);
  const loc = locale as Locale;
  const money = (c: number) => formatMoney(c, { currency, locale: loc, fractionDigits: "auto" });
  const docsTotal = p.docs.reduce((s, d) => s + d.creditCents + d.moneyCents, 0);
  const tcFn = (key: string, values?: Record<string, string | number>) => tc(key, values);

  return (
    <div className="p-4 lg:p-6 max-w-3xl mx-auto w-full">
      <div className="no-print mb-4 flex flex-wrap items-center justify-between gap-2">
        <Link href="/operator/compras/pagos" className="text-sm text-op-muted hover:text-op-text">
          {`← ${t("backToPayments")}`}
        </Link>
        <div className="flex gap-2">
          <PrintButton />
          {p.status === "active" && <VoidVoucher id={p.id} />}
        </div>
      </div>

      <article className="rounded-3xl border border-op-border bg-op-surface p-5 sm:p-8 print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-op-border pb-4">
          <div>
            <div className="font-display text-xl">{tenant.legalName ?? tenant.name}</div>
            {tenant.taxId && <div className="text-sm text-op-muted">{t("taxIdLine", { taxId: tenant.taxId })}</div>}
          </div>
          <div className="text-right">
            <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-op-muted">{t("voucherTitle")}</div>
            <div className="font-mono text-2xl">{voucherNumberLabel(p.number)}</div>
            {p.status === "voided" && <div className="mt-1 text-sm font-medium text-danger">{t("voidedOn", { date: formatDate(p.voidedAt!, { locale: loc, timeStyle: undefined }) })}</div>}
          </div>
        </header>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 py-4 text-sm border-b border-op-border">
          <Row label={t("paidTo")} value={`${p.supplier.name}${p.supplier.taxId ? ` · ${t("taxIdLine", { taxId: p.supplier.taxId })}` : ""}`} />
          <Row label={t("fieldDate")} value={formatDate(p.date, { locale: loc, timeStyle: undefined })} />
          <Row label={t("fieldAccount")} value={`${p.accountCode}${p.accountName ? ` · ${p.accountName}` : ""}`} />
          <Row label={t("fieldMethod")} value={p.method ? (isSupplierPaymentMethod(p.method) ? t(`method_${p.method}`) : p.method) : "—"} />
          {p.reference && <Row label={t("fieldReference")} value={p.reference} />}
          {p.note && <Row label={t("fieldNote")} value={p.note} />}
        </dl>

        <table className="w-full text-sm mt-4">
          <thead>
            <tr className="border-b border-op-border text-op-muted font-mono text-[10px] tracking-[0.12em] uppercase">
              <th className="py-2 text-left font-normal">{t("colDoc")}</th>
              <th className="py-2 text-right font-normal">{t("colCredit")}</th>
              <th className="py-2 text-right font-normal">{t("colPayment")}</th>
            </tr>
          </thead>
          <tbody>
            {p.docs.map((d) => (
              <tr key={`${d.kind}:${d.id}`} className="border-b border-op-border/60">
                <td className="py-2 pr-2">{docLabel(tcFn, d)}</td>
                <td className="py-2 text-right tabular-nums">{d.creditCents ? money(d.creditCents) : "—"}</td>
                <td className="py-2 text-right tabular-nums">{d.moneyCents ? money(d.moneyCents) : "—"}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td className="py-2">{t("appliedToInvoices")}</td>
              <td className="py-2 text-right tabular-nums">{money(p.creditAppliedCents)}</td>
              <td className="py-2 text-right tabular-nums">{money(docsTotal - p.creditAppliedCents)}</td>
            </tr>
          </tfoot>
        </table>

        {p.credits.length > 0 && (
          <div className="mt-4 text-sm">
            <div className="font-mono text-[10px] tracking-[0.12em] uppercase text-op-muted mb-1">{t("creditsCrossed")}</div>
            <ul className="space-y-0.5">
              {p.credits.map((c) => (
                <li key={`${c.source}:${c.label}`} className="flex justify-between">
                  <span>{c.source === "note" ? t("creditNote", { number: c.label }) : t("creditAdvance", { number: c.label.padStart(4, "0") })}</span>
                  <span className="tabular-nums">{money(c.amountCents)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-6 flex flex-col items-end gap-1 text-sm">
          <div className="flex gap-6">
            <span className="text-op-muted">{t("totalPaying")}</span>
            <span className="font-semibold tabular-nums text-lg">{money(p.amountCents)}</span>
          </div>
          {p.advanceCents > 0 && (
            <div className="flex gap-6 text-[#7F5A1F]">
              <span>{t("advanceLine")}</span>
              <span className="tabular-nums">{money(p.advanceCents)}</span>
            </div>
          )}
        </div>
        {p.attachmentUrl && (
          <a href={p.attachmentUrl} target="_blank" rel="noopener noreferrer" className="no-print mt-4 inline-block text-xs underline text-op-muted">
            {t("attachView")}
          </a>
        )}
        <div className="mt-10 grid grid-cols-2 gap-8 text-[11px] text-op-muted print:mt-16">
          <div className="border-t border-op-border pt-1">{t("signatureMade")}</div>
          <div className="border-t border-op-border pt-1">{t("signatureReceived")}</div>
        </div>
      </article>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}
