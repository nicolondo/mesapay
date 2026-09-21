import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import {
  buildStatement,
  NO_SUPPLIER_ID,
  type CarteraDocSource,
  type CarteraKind,
  type StatementEntry,
} from "@/lib/erp/reports/cartera";
import { loadPartnerMovements } from "@/lib/erp/reports/carteraQueries";
import { carteraStatementQuery } from "@/lib/erp/reports/params";
import { todayIso } from "@/lib/erp/reports/period";
import { firstParam, reportGate } from "../../../_components/gate";
import { fmtIsoDate } from "../../../_components/fmt";
import { PrintButton } from "../../../_components/PrintButton";
import {
  EmptyNote,
  FilterField,
  ReportFilterForm,
  ReportShell,
  StatTile,
} from "../../../_components/ReportShell";

export const dynamic = "force-dynamic";

type Params = Promise<{ kind: string; partnerId: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const KIND_BY_SLUG: Record<string, CarteraKind> = { proveedor: "cxp", cliente: "cxc" };

const TH = "px-3 py-2 font-mono text-[9px] uppercase tracking-wider font-normal";
const NUM = "px-3 py-2 text-right font-mono tabular whitespace-nowrap";

const SOURCE_KEY: Record<CarteraDocSource, "srcPurchaseOrder" | "srcExpense" | "srcVoucherStatement"> = {
  purchase_order: "srcPurchaseOrder",
  expense: "srcExpense",
  voucher_statement: "srcVoucherStatement",
};

/**
 * A dónde lleva cada documento. Compras y contabilidad no tienen ruta
 * por documento (abren la pantalla del módulo); los cortes de bonos sí
 * se filtran por cliente en su reporte.
 */
function docHref(source: CarteraDocSource, partnerId: string): { href: string; key: "openInPurchases" | "openInAccounting" | "openInVouchers" } {
  switch (source) {
    case "purchase_order":
      return { href: "/operator/compras", key: "openInPurchases" };
    case "expense":
      return { href: "/operator/contabilidad", key: "openInAccounting" };
    case "voucher_statement":
      return { href: `/operator/bonos/reporte?customer=${encodeURIComponent(partnerId)}`, key: "openInVouchers" };
  }
}

/**
 * Extracto (estado de cuenta) de un tercero: cargos por documento y
 * abonos por pago en orden cronológico con saldo corrido, más la tabla de
 * edades por antigüedad del documento. Portado de zenith
 * `reportes/cartera/[partnerId]/page.tsx` (sin FIFO ni anticipos).
 */
export default async function CarteraExtractoPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { kind: slug, partnerId } = await params;
  const kind = KIND_BY_SLUG[slug];
  if (!kind) notFound();

  const [t, tSettings, locale] = await Promise.all([
    getTranslations("opCartera"),
    getTranslations("opSettings"),
    getLocale(),
  ]);
  const gate = await reportGate();
  if (!gate) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const sp = await searchParams;
  const parsed = carteraStatementQuery.safeParse(
    Object.fromEntries(Object.entries({ hasta: firstParam(sp.hasta) }).filter(([, v]) => v)),
  );
  const asOf = (parsed.success ? parsed.data.hasta : undefined) ?? todayIso();

  const data = await loadPartnerMovements(gate.restaurantId, kind, partnerId, asOf);
  if (!data) notFound();
  const st = buildStatement(data.docs, data.payments, asOf);

  const loc = locale as Locale;
  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const dateLabel = fmtIsoDate(asOf, loc);
  const name = partnerId === NO_SUPPLIER_ID ? t("noSupplier") : data.partner.name;
  const backHref = `/operator/reportes/cartera?vista=${kind}&hasta=${asOf}`;

  const ageRows: { label: string; cents: number; tone?: "danger" }[] = [
    { label: t("age0_30"), cents: st.aging.d0a30Cents },
    { label: t("age31_60"), cents: st.aging.d31a60Cents },
    { label: t("age61_90"), cents: st.aging.d61a90Cents },
    { label: t("age90"), cents: st.aging.mas90Cents },
    { label: t("totalPending"), cents: st.aging.pendingCents },
    { label: t("totalOverdue"), cents: st.aging.overdueCents, tone: "danger" },
  ];

  return (
    <ReportShell
      title={t("stTitle", { name })}
      description={t("stSubtitle", { date: dateLabel })}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("stPrintTitle"),
        subtitle: `${name}${data.partner.taxId ? ` · ${t("colTaxId")} ${data.partner.taxId}` : ""} · ${t("asOf", { date: dateLabel })}`,
      }}
      filters={
        <ReportFilterForm>
          <FilterField label={t("filterAsOf")}>
            <input
              type="date"
              name="hasta"
              defaultValue={asOf}
              className="w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm"
            />
          </FilterField>
        </ReportFilterForm>
      }
      actions={<PrintButton />}
      statCols={3}
      stats={
        <>
          <StatTile label={t("totalPending")} value={money(st.aging.pendingCents)} />
          <StatTile
            label={t("totalOverdue")}
            value={money(st.aging.overdueCents)}
            tone={st.aging.overdueCents > 0 ? "danger" : "default"}
          />
          <StatTile label={t("finalBalance")} value={money(st.totals.balanceCents)} />
        </>
      }
      note={t("agingNote")}
    >
      <div className="no-print">
        <Link href={backHref} className="text-sm text-op-muted hover:text-op-text">
          ← {t("backToCartera")}
        </Link>
      </div>

      <div className="rounded-2xl border border-op-border bg-op-surface px-4 py-3">
        <div className="text-[10px] uppercase tracking-wider text-op-muted">
          {kind === "cxp" ? t("kindSupplier") : t("kindCustomer")}
        </div>
        <div className="mt-1 text-lg font-semibold">{name}</div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-op-muted">
          {data.partner.taxId && (
            <span>
              {t("colTaxId")} <span className="font-mono">{data.partner.taxId}</span>
            </span>
          )}
          {data.partner.phone && <span>{t("phone", { phone: data.partner.phone })}</span>}
          {data.partner.email && <span>{t("email", { email: data.partner.email })}</span>}
        </div>
      </div>

      {st.entries.length === 0 ? (
        <EmptyNote>{t("stEmpty")}</EmptyNote>
      ) : (
        <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="border-b border-op-border text-op-muted">
                  <th className={`${TH} text-left`}>{t("colDate")}</th>
                  <th className={`${TH} text-left`}>{t("colDocument")}</th>
                  <th className={`${TH} text-right`}>{t("colCharge")}</th>
                  <th className={`${TH} text-right`}>{t("colPayment")}</th>
                  <th className={`${TH} text-right`}>{t("colRunning")}</th>
                </tr>
              </thead>
              <tbody>
                {st.entries.map((e) => (
                  <EntryRow key={e.key} entry={e} partnerId={partnerId} money={money} locale={loc} />
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
                  <td className="px-3 py-2" colSpan={2}>
                    {t("finalBalance")}
                  </td>
                  <td className={NUM}>{money(st.totals.cargosCents)}</td>
                  <td className={NUM}>{money(st.totals.abonosCents)}</td>
                  <td className={NUM}>{money(st.totals.balanceCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-[11px] uppercase tracking-wider text-op-muted">{t("agingTitle")}</h2>
        <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead>
                <tr className="border-b border-op-border text-op-muted">
                  {ageRows.map((r) => (
                    <th key={r.label} className={`${TH} text-right`}>
                      {r.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {ageRows.map((r) => (
                    <td
                      key={r.label}
                      className={`${NUM} ${r.tone === "danger" && r.cents > 0 ? "font-semibold text-danger" : ""}`}
                    >
                      {money(r.cents)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </ReportShell>
  );
}

/** Una fila del extracto: cargo (con enlace al módulo) o abono. */
async function EntryRow({
  entry: e,
  partnerId,
  money,
  locale,
}: {
  entry: StatementEntry;
  partnerId: string;
  money: (c: number) => string;
  locale: Locale;
}) {
  const t = await getTranslations("opCartera");
  const link = e.kind === "cargo" ? docHref(e.source, partnerId) : null;
  return (
    <tr className="border-b border-op-border/60 last:border-b-0">
      <td className="px-3 py-2 whitespace-nowrap">{fmtIsoDate(e.date, locale)}</td>
      <td className="px-3 py-2 min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={e.kind === "abono" ? "text-op-muted" : "font-medium"}>
            {e.kind === "abono" ? t("srcPayment") : t(SOURCE_KEY[e.source])}
          </span>
          <span className="font-mono text-xs">{e.number}</span>
          {e.dueDate && (
            <span className="text-xs text-op-muted">{t("dueOn", { date: fmtIsoDate(e.dueDate, locale) })}</span>
          )}
          {e.note && <span className="text-xs text-op-muted">{e.note}</span>}
          {link && (
            <Link href={link.href} className="no-print text-xs text-op-accent hover:underline">
              {t(link.key)}
            </Link>
          )}
        </div>
      </td>
      <td className={NUM}>{e.cargoCents > 0 ? money(e.cargoCents) : ""}</td>
      <td className={NUM}>{e.abonoCents > 0 ? money(e.abonoCents) : ""}</td>
      <td className={`${NUM} font-semibold`}>{money(e.balanceCents)}</td>
    </tr>
  );
}
