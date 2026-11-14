import Link from "next/link";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { formatDate, formatMoney } from "@/lib/format";
import { GENERATION_FORMS } from "@/lib/dian/supportDocument/constants";
import {
  DS_DENOMINATION,
  NAS_DENOMINATION,
  supportDocQrText,
} from "@/lib/dian/supportDocument/presentation";
import { loadSupportDocForPrint } from "@/lib/dian/supportDocument/view";
import { PrintButton } from "./PrintButton";

export const dynamic = "force-dynamic";

/**
 * Representación gráfica del documento soporte o de la nota de ajuste (art.
 * 22 Res. 000167 de 2021): denominación expresa, número con la autorización
 * (rango y vigencia), fecha, vendedor y adquiriente con su identificación,
 * descripción, valores con el IVA discriminado, CUDS y código QR (§12.2 del
 * anexo, mínimo 2 × 2 cm). La entrega al vendedor es opcional (§4.5).
 */
export default async function SupportDocumentPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(["einvoicing"]);
  if (isDenied(ctx)) notFound();
  const { id } = await params;
  const data = await loadSupportDocForPrint(ctx.restaurantId, id);
  if (!data) notFound();
  const { view, snapshot: s, adjustsNumber } = data;
  const t = await getTranslations("opSupportDoc");
  const locale = (await getLocale()) as Locale;
  // El documento soporte es colombiano: sus valores van en pesos (el XML
  // declara DocumentCurrencyCode COP).
  const money = (c: number) => formatMoney(c, { currency: "COP", locale, fractionDigits: 2 });
  const day = (iso: string) => formatDate(`${iso}T12:00:00-05:00`, { locale, dateStyle: "long", timeStyle: undefined });
  const isNote = view.kind === "adjustment_note";
  const qr = view.cuds
    ? await QRCode.toDataURL(
        supportDocQrText({ documentNumber: view.documentNumber, environment: view.environment, cuds: view.cuds, snapshot: s }),
        { margin: 1, width: 220, errorCorrectionLevel: "M" },
      )
    : null;
  const sellerAddress =
    s.seller.address.kind === "resident"
      ? `${s.seller.address.line} · ${s.seller.address.cityName}, ${s.seller.address.deptName} · ${s.seller.address.postalZone}`
      : [s.seller.address.line, s.seller.address.cityName, s.seller.address.countryName].filter(Boolean).join(" · ");
  const sellerId = s.seller.dv ? `${s.seller.companyId}-${s.seller.dv}` : s.seller.companyId;
  const withholdings = s.lines.flatMap((l) => l.withholdings);
  const reteRenta = withholdings.filter((w) => w.schemeId === "06").reduce((a, w) => a + w.amountCents, 0);
  const reteIva = withholdings.filter((w) => w.schemeId === "05").reduce((a, w) => a + w.amountCents, 0);
  const forms = [...new Set(s.lines.map((l) => l.generationForm))];

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto w-full">
      <div className="flex items-center justify-between gap-3 mb-4 print:hidden flex-wrap">
        <Link
          href={s.source.type === "expense" ? "/operator/contabilidad?tab=expenses" : "/operator/compras"}
          className="font-mono text-[11px] tracking-[0.14em] uppercase text-op-muted hover:text-ink"
        >
          {t(s.source.type === "expense" ? "backExpenses" : "backPurchases")}
        </Link>
        <div className="flex gap-2">
          {view.hasXml && (
            <a href={`/api/operator/support-documents/${view.id}/xml`} className="mp-btn mp-btn--ghost mp-btn--sm">
              {t("downloadXml")}
            </a>
          )}
          <PrintButton />
        </div>
      </div>

      <article className="rounded-2xl border border-op-border bg-white text-ink p-6 space-y-5 print:border-0 print:p-0">
        {view.environment === "2" && (
          <div className="rounded-lg border border-[#C98A2E]/50 bg-[#C98A2E]/10 px-3 py-2 text-sm font-medium text-[#7F5A1F]">
            {t("testBanner")}
          </div>
        )}
        {view.state !== "accepted" && (
          <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {t("notAccepted", { state: t(`state.${view.state}`) })}
          </div>
        )}

        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold leading-snug">{isNote ? NAS_DENOMINATION : DS_DENOMINATION}</h1>
            <div className="text-2xl font-semibold mt-1">{view.documentNumber}</div>
            {!isNote && s.resolution && (
              <p className="text-xs text-op-muted mt-1">
                {t("authorization", {
                  number: s.resolution.number,
                  prefix: s.resolution.prefix,
                  from: s.resolution.from,
                  to: s.resolution.to,
                  start: day(s.resolution.startDate),
                  end: day(s.resolution.endDate),
                })}
              </p>
            )}
            {isNote && <p className="text-xs text-op-muted mt-1">{t("internalNumbering")}</p>}
          </div>
          {qr && (
            // eslint-disable-next-line @next/next/no-img-element -- data: URL generada en el server
            <img src={qr} alt={t("qrAlt")} className="w-[110px] h-[110px] shrink-0" />
          )}
        </header>

        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-xs text-op-muted">{t("issueDate")}</dt>
            <dd>{s.issueDate ? `${day(s.issueDate)} · ${s.issueTime}` : "—"}</dd>
          </div>
          {!isNote && (
            <div>
              <dt className="text-xs text-op-muted">{t("operationDate")}</dt>
              <dd>
                {day(s.source.operationDate)} · {forms.map((f) => GENERATION_FORMS[f]).join(", ")}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-op-muted">{t("seller")}</dt>
            <dd className="font-medium">{s.seller.name}</dd>
            <dd>
              {t("sellerId", { scheme: s.seller.idSchemeName === "31" ? "NIT" : s.seller.idSchemeName, id: sellerId })}
            </dd>
            <dd className="text-xs text-op-muted">{sellerAddress}</dd>
          </div>
          <div>
            <dt className="text-xs text-op-muted">{t("buyer")}</dt>
            <dd className="font-medium">{s.buyer.name}</dd>
            <dd>{t("sellerId", { scheme: "NIT", id: `${s.buyer.nit}-${s.buyer.dv}` })}</dd>
          </div>
          <div>
            <dt className="text-xs text-op-muted">{t("paymentForm")}</dt>
            <dd>
              {s.paymentMeans.id === "2"
                ? t("credit", { date: s.paymentMeans.dueDate ? day(s.paymentMeans.dueDate) : "—" })
                : t("cash")}
            </dd>
          </div>
          {s.source.label && (
            <div>
              <dt className="text-xs text-op-muted">{t(s.source.type === "expense" ? "sourceExpense" : "sourcePurchase")}</dt>
              <dd>{s.source.label}</dd>
            </div>
          )}
        </dl>

        {isNote && s.reference && (
          <div className="text-sm space-y-1">
            <div>
              <span className="text-xs text-op-muted">{t("reference")}: </span>
              {adjustsNumber ?? s.reference.documentNumber} · {day(s.reference.issueDate)}
            </div>
            <div className="text-[11px] text-op-muted break-all">
              {t("cuds")}: {s.reference.cuds}
            </div>
            <div>
              <span className="text-xs text-op-muted">{t("reasonLabel")}: </span>
              {t(`reason.${s.reasonCode}`)} — {s.reasonText}
            </div>
          </div>
        )}

        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-op-muted border-b border-op-border">
              <th className="py-2 pr-2 font-normal">{t("description")}</th>
              <th className="py-2 px-2 font-normal text-right">{t("qty")}</th>
              <th className="py-2 px-2 font-normal text-right">{t("ivaCol")}</th>
              <th className="py-2 pl-2 font-normal text-right">{t("lineTotal")}</th>
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l, i) => (
              <tr key={i} className="border-b border-op-border/60 align-top">
                <td className="py-2 pr-2 break-words">{l.description}</td>
                <td className="py-2 px-2 text-right">{l.quantity}</td>
                <td className="py-2 px-2 text-right">{l.ivaCents > 0 ? `${money(l.ivaCents)} (${l.ivaPct}%)` : "—"}</td>
                <td className="py-2 pl-2 text-right">{money(l.lineTotalCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="ml-auto max-w-xs text-sm space-y-1">
          <div className="flex justify-between gap-4">
            <dt>{t("subtotal")}</dt>
            <dd>{money(view.subtotalCents)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>{t("iva")}</dt>
            <dd>{money(view.taxCents)}</dd>
          </div>
          <div className="flex justify-between gap-4 font-semibold border-t border-op-border pt-1">
            <dt>{t("total")}</dt>
            <dd>{money(view.totalCents)}</dd>
          </div>
          {reteRenta > 0 && (
            <div className="flex justify-between gap-4 text-xs text-op-muted">
              <dt>{t("retention.retefuente")}</dt>
              <dd>{money(reteRenta)}</dd>
            </div>
          )}
          {reteIva > 0 && (
            <div className="flex justify-between gap-4 text-xs text-op-muted">
              <dt>{t("retention.reteiva")}</dt>
              <dd>{money(reteIva)}</dd>
            </div>
          )}
        </dl>

        <footer className="space-y-1 text-[11px] text-op-muted border-t border-op-border pt-3">
          <div className="break-all">
            {t("cuds")}: {view.cuds ?? "—"}
          </div>
          <div>{t("softwareLine")}</div>
        </footer>
      </article>
    </div>
  );
}
