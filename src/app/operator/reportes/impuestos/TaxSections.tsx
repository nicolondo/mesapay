import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import type { CrossRow } from "@/lib/erp/reports/taxesCross";
import {
  documentFamilies,
  familyTax,
  type DocumentTaxes,
  type TaxBucket,
} from "@/lib/erp/reports/taxesDocuments";
import type { FamilyKey, TaxAccountReport } from "@/lib/erp/reports/taxesModel";
import { retentionConceptLabel, type RetentionRow, type TaxDocRow } from "@/lib/erp/reports/taxesDetail";
import { fmtIsoDate } from "../_components/fmt";

/**
 * Secciones de los reportes de impuestos (server components, sin estado):
 * tarjetas por familia documental, tablas por tarifa, grupos del libro,
 * cruce y las tablas del detalle. Portado de zenith `impuestos-resumen.tsx`,
 * `impuestos-cuentas.tsx` e `impuestos-detallados/page.tsx`.
 */

const TH = "px-3 py-2 font-mono text-[9px] uppercase tracking-wider font-normal";
const NUM = "px-3 py-1.5 text-right font-mono tabular whitespace-nowrap";
const CELL = "px-3 py-1.5";

async function fmt(currency: string) {
  const locale = (await getLocale()) as Locale;
  return {
    locale,
    money: (c: number) => formatMoney(c, { currency, locale }),
  };
}

/** Tarjeta contenedora de una sección. */
export function Card({
  title,
  note,
  children,
}: {
  title?: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
      {(title || note) && (
        <div className="border-b border-op-border px-4 py-3">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {note && <p className="mt-0.5 text-xs text-op-muted">{note}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Etiqueta de una familia del libro (`opImpuestosRep.fam_<key>`). */
export function familyLabelKey(key: FamilyKey): string {
  return `fam_${key.replaceAll("-", "_")}`;
}

/** Tarjetas «Generado en ventas / Registrado en compras / Diferencia documental» por familia. */
export async function TaxFamilyCards({ docs, currency }: { docs: DocumentTaxes; currency: string }) {
  const t = await getTranslations("opImpuestosRep");
  const { money } = await fmt(currency);
  const families = documentFamilies(docs);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {families.map((kind) => {
        const sold = familyTax(docs.sales, kind);
        const bought = familyTax(docs.purchases, kind);
        return (
          <div key={kind} className="rounded-2xl border border-op-border bg-op-surface px-4 py-3">
            <h2 className="text-sm font-semibold">{kind === "iva" ? t("famIva") : t("famInc")}</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-op-muted">{t("cardSales")}</dt>
                <dd className="font-semibold font-mono tabular">{money(sold)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-op-muted">{t("cardPurchases")}</dt>
                <dd className="font-mono tabular">{money(bought)}</dd>
              </div>
              {kind === "iva" && (
                <div className="flex justify-between gap-3 border-t border-op-border pt-2">
                  <dt>{t("cardDiff")}</dt>
                  <dd className="font-semibold font-mono tabular">{money(sold - bought)}</dd>
                </div>
              )}
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-op-muted">
              {kind === "iva" ? t("noteIva") : t("noteInc")}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function bucketLabelKey(kind: TaxBucket["kind"]): string {
  switch (kind) {
    case "iva":
      return "famIva";
    case "inc":
      return "famInc";
    default:
      return `taxKind_${kind}`;
  }
}

/** Tabla Impuesto · Tarifa · Base · Devoluciones · Impuesto registrado + total. */
export async function TaxDocumentTable({
  title,
  note,
  rows,
  currency,
}: {
  title: string;
  note: string;
  rows: TaxBucket[];
  currency: string;
}) {
  const t = await getTranslations("opImpuestosRep");
  const { money } = await fmt(currency);
  const hasRefunds = rows.some((r) => r.refundTaxCents !== 0);
  const total = rows.reduce((s, r) => s + r.taxCents, 0);
  return (
    <Card title={title} note={note}>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-op-muted">{t("noDocs")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="border-b border-op-border text-op-muted">
                <th className={`${TH} text-left`}>{t("colTax")}</th>
                <th className={`${TH} text-right`}>{t("colRate")}</th>
                <th className={`${TH} text-right`}>{t("colBase")}</th>
                {hasRefunds && <th className={`${TH} text-right`}>{t("colRefunds")}</th>}
                <th className={`${TH} text-right`}>{t("colTaxAmount")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-op-border/50">
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className={CELL}>{t(bucketLabelKey(r.kind))}</td>
                  <td className={NUM}>{r.pct == null ? t("noRate") : t("ratePct", { pct: r.pct })}</td>
                  <td className={NUM}>{money(r.baseCents)}</td>
                  {hasRefunds && <td className={NUM}>{money(-r.refundTaxCents)}</td>}
                  <td className={`${NUM} font-medium`}>{money(r.taxCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
                <td className="px-3 py-2" colSpan={hasRefunds ? 4 : 3}>
                  {t("totalTax")}
                </td>
                <td className={NUM}>{money(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Los dos grupos del libro (por pagar / a favor) con familias, subtotales y cuentas. */
export async function TaxGroupCards({ book, currency }: { book: TaxAccountReport; currency: string }) {
  const [t, tRep] = await Promise.all([
    getTranslations("opImpuestosRep"),
    getTranslations("opReportes"),
  ]);
  const { money } = await fmt(currency);
  if (book.groups.length === 0) {
    return (
      <Card title={t("bookTitle")}>
        <p className="px-4 py-6 text-center text-sm text-op-muted">{t("noBook")}</p>
      </Card>
    );
  }
  return (
    <>
      {book.groups.map((g) => (
        <Card
          key={g.key}
          title={g.key === "pagar" ? t("groupPagar") : t("groupFavor")}
          note={g.key === "pagar" ? t("groupPagarNote") : t("groupFavorNote")}
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[480px]">
              <thead>
                <tr className="border-b border-op-border text-op-muted">
                  <th className={`${TH} text-left`}>{tRep("colAccount")}</th>
                  <th className={`${TH} text-left`}>{tRep("colName")}</th>
                  <th className={`${TH} text-right`}>{t("colMovement")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-op-border/50">
                {g.families.map((f) => (
                  <FamilyRows key={f.key} family={f} label={t(familyLabelKey(f.key))} money={money} />
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
                  <td className="px-3 py-2" colSpan={2}>
                    {t("totalMovement")}
                  </td>
                  <td className={NUM}>{money(g.totalCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      ))}
    </>
  );
}

function FamilyRows({
  family,
  label,
  money,
}: {
  family: TaxAccountReport["groups"][number]["families"][number];
  label: string;
  money: (c: number) => string;
}) {
  return (
    <>
      <tr className="bg-op-bg/60">
        <td className="px-3 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-op-muted" colSpan={2}>
          {label}
        </td>
        <td className={`${NUM} pt-3 pb-1.5 text-xs font-semibold`}>{money(family.subtotalCents)}</td>
      </tr>
      {family.rows.map((r) => (
        <tr key={r.code}>
          <td className={`${CELL} font-mono text-xs text-op-muted`}>{r.code}</td>
          <td className={`${CELL} max-w-[18rem] truncate`}>{r.name}</td>
          <td className={`${NUM} font-medium`}>{money(r.valorCents)}</td>
        </tr>
      ))}
    </>
  );
}

function crossLabelKey(key: CrossRow["key"]): string {
  if (key === "iva") return "famIva";
  if (key === "consumo") return "famInc";
  return familyLabelKey(key);
}

/** Cruce documental vs libro por familia, con la diferencia resaltada. */
export async function TaxCrossTable({ cross, currency }: { cross: CrossRow[]; currency: string }) {
  const t = await getTranslations("opImpuestosRep");
  const { money } = await fmt(currency);
  if (cross.length === 0) return null;
  return (
    <Card title={t("crossTitle")} note={t("crossNote")}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[520px]">
          <thead>
            <tr className="border-b border-op-border text-op-muted">
              <th className={`${TH} text-left`}>{t("colFamily")}</th>
              <th className={`${TH} text-right`}>{t("colReference")}</th>
              <th className={`${TH} text-right`}>{t("colBook")}</th>
              <th className={`${TH} text-right`}>{t("colDifference")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-op-border/50">
            {cross.map((r) => (
              <tr key={r.key}>
                <td className={CELL}>{t(crossLabelKey(r.key))}</td>
                <td className={NUM}>{money(r.referenceCents)}</td>
                <td className={NUM}>{money(r.bookCents)}</td>
                <td className={`${NUM} font-semibold ${r.differenceCents !== 0 ? "text-danger" : "text-op-accent"}`}>
                  {money(r.differenceCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-3 text-xs leading-relaxed text-op-muted">{t("crossFootnote")}</p>
    </Card>
  );
}

/** Detalle: Fecha · Documento · NIT · Tercero · Impuesto · Tarifa · Base · Valor + total. */
export async function TaxDocDetailTable({
  title,
  note,
  rows,
  currency,
}: {
  title: string;
  note: string;
  rows: TaxDocRow[];
  currency: string;
}) {
  const [t, tRep] = await Promise.all([
    getTranslations("opImpuestosRep"),
    getTranslations("opReportes"),
  ]);
  const { money, locale } = await fmt(currency);
  const totalBase = rows.reduce((s, r) => s + r.baseCents, 0);
  const totalValor = rows.reduce((s, r) => s + r.valorCents, 0);
  return (
    <Card title={title} note={note}>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-op-muted">{tRep("noData")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="border-b border-op-border text-op-muted">
                <th className={`${TH} text-left`}>{tRep("colDate")}</th>
                <th className={`${TH} text-left`}>{t("colDocument")}</th>
                <th className={`${TH} text-left`}>{t("colNit")}</th>
                <th className={`${TH} text-left`}>{t("colParty")}</th>
                <th className={`${TH} text-left`}>{t("colTax")}</th>
                <th className={`${TH} text-right`}>{t("colRate")}</th>
                <th className={`${TH} text-right`}>{t("colBase")}</th>
                <th className={`${TH} text-right`}>{t("colValue")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-op-border/50">
              {rows.map((r) => (
                <tr key={r.key}>
                  <td className={`${CELL} font-mono text-xs text-op-muted whitespace-nowrap`}>
                    {fmtIsoDate(r.dateIso, locale)}
                  </td>
                  <td className={`${CELL} font-mono text-xs whitespace-nowrap`}>{r.document}</td>
                  <td className={`${CELL} font-mono text-xs text-op-muted`}>{r.nit ?? "—"}</td>
                  <td className={`${CELL} max-w-[14rem] truncate`}>{r.party ?? t("finalConsumer")}</td>
                  <td className={CELL}>{r.kind === "iva" ? t("famIva") : t("famInc")}</td>
                  <td className={NUM}>{t("ratePct", { pct: r.pct })}</td>
                  <td className={NUM}>{money(r.baseCents)}</td>
                  <td className={`${NUM} font-medium`}>{money(r.valorCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
                <td className="px-3 py-2" colSpan={6}>
                  {tRep("total")}
                </td>
                <td className={NUM}>{money(totalBase)}</td>
                <td className={NUM}>{money(totalValor)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

/** Detalle de retenciones: Fecha · Comprobante · Origen · NIT · Tercero · Concepto · Valor + total. */
export async function RetentionDetailTable({
  title,
  note,
  rows,
  currency,
  sourceLabel,
}: {
  title: string;
  note: string;
  rows: RetentionRow[];
  currency: string;
  sourceLabel: (source: string) => string;
}) {
  const [t, tRep] = await Promise.all([
    getTranslations("opImpuestosRep"),
    getTranslations("opReportes"),
  ]);
  const { money, locale } = await fmt(currency);
  const total = rows.reduce((s, r) => s + r.valorCents, 0);
  return (
    <Card title={title} note={note}>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-op-muted">{tRep("noData")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead>
              <tr className="border-b border-op-border text-op-muted">
                <th className={`${TH} text-left`}>{tRep("colDate")}</th>
                <th className={`${TH} text-left`}>{tRep("colVoucher")}</th>
                <th className={`${TH} text-left`}>{tRep("colSource")}</th>
                <th className={`${TH} text-left`}>{t("colNit")}</th>
                <th className={`${TH} text-left`}>{t("colParty")}</th>
                <th className={`${TH} text-left`}>{t("colConcept")}</th>
                <th className={`${TH} text-right`}>{t("colValue")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-op-border/50">
              {rows.map((r) => (
                <tr key={r.key} className={r.voided ? "text-op-muted line-through" : undefined}>
                  <td className={`${CELL} font-mono text-xs text-op-muted whitespace-nowrap`}>
                    {fmtIsoDate(r.dateIso, locale)}
                  </td>
                  <td className={`${CELL} font-mono text-xs whitespace-nowrap`}>
                    {r.voucher ?? tRep("unnumbered")}
                    {r.voided && (
                      <span className="ml-1 rounded-full bg-danger/10 px-1.5 text-[10px] text-danger no-underline">
                        {tRep("voided")}
                      </span>
                    )}
                  </td>
                  <td className={`${CELL} text-xs text-op-muted`}>{sourceLabel(r.source)}</td>
                  <td className={`${CELL} font-mono text-xs text-op-muted`}>{r.nit ?? "—"}</td>
                  <td className={`${CELL} max-w-[14rem] truncate`}>{r.party ?? "—"}</td>
                  <td className={CELL}>{retentionConceptLabel(r)}</td>
                  <td className={`${NUM} font-medium`}>{money(r.valorCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
                <td className="px-3 py-2" colSpan={6}>
                  {tRep("total")}
                </td>
                <td className={NUM}>{money(total)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}
