import Link from "next/link";
import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { db } from "@/lib/db";
import { formatMoney, localeTag } from "@/lib/format";
import {
  catalogoFormatos,
  CUANTIA_MENOR_PAGOS_UVT,
  CUANTIA_MENOR_SALDOS_UVT,
  parseAnoGravable,
  resolucionesDelAno,
  umbralPagosCents,
  umbralSaldosCents,
  type CatalogoFormato,
  type FormatoExogena,
} from "@/lib/erp/exogena/normativa";
import { loadExogenaReport } from "@/lib/erp/exogena/queries";
import type { ExogenaIssue, Tercero } from "@/lib/erp/exogena/sources";
import { firstParam, reportGate } from "../_components/gate";
import {
  EmptyNote,
  FilterField,
  ReportFilterForm,
  ReportShell,
  StatTile,
} from "../_components/ReportShell";
import { DeleteRowButton, HoldingForm, ShareholderForm } from "./ManualForms";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Información exógena DIAN (sólo Colombia): normativa del año gravable,
 * incidencias de terceros, una tarjeta por formato con su tabla y la
 * descarga del XML oficial, y captura manual de socios (1010) e
 * inversiones (1012). Portado de zenith `reportes/exogena/page.tsx`.
 */
export default async function ExogenaPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, tSettings, locale] = await Promise.all([
    getTranslations("opExogena"),
    getTranslations("opSettings"),
    getLocale(),
  ]);
  const gate = await reportGate();
  if (!gate) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: gate.restaurantId },
    select: { country: true },
  });
  if (tenant?.country?.trim().toUpperCase() !== "CO") {
    return (
      <ReportShell title={t("title")} description={t("subtitle")}>
        <EmptyNote>{t("notColombia")}</EmptyNote>
      </ReportShell>
    );
  }

  const sp = await searchParams;
  const year = parseAnoGravable(firstParam(sp.year)) ?? parseAnoGravable(null)!;
  const loc = locale as Locale;
  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const pctFmt = new Intl.NumberFormat(localeTag(loc), { style: "percent", maximumFractionDigits: 4 });
  const inputCls = "w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm";

  const { uvtPesos, report } = await loadExogenaReport(gate.restaurantId, year);
  const catalog = catalogoFormatos(year);
  const F = (code: FormatoExogena): CatalogoFormato => catalog.find((f) => f.codigo === code)!;
  const blocked = (code: FormatoExogena) =>
    report.issues.some((i) => i.format === code && i.blocking);
  const f = report.formats;

  /** Documento y nombre del tercero para la tabla (consumidor final traducido). */
  const tercero = (x: Tercero): [ReactNode, ReactNode] =>
    x.key === "cf"
      ? [<span key="d" className="font-mono text-xs">{x.docNumber}</span>, t("consumidorFinal")]
      : [
          <span key="d" className="font-mono text-xs whitespace-nowrap">
            {x.docType ?? ""} {x.docNumber ?? "—"}
          </span>,
          x.name,
        ];

  const numCols = (labels: string[]) => labels.map((label) => ({ label, num: true }));
  const txtCols = (labels: string[]) => labels.map((label) => ({ label }));
  const totalRow = (label: string, cells: ReactNode[]) => [label, ...cells];

  return (
    <ReportShell
      title={t("title")}
      description={t("subtitle")}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("title"),
        subtitle: `${t("yearLabel")} ${year}`,
      }}
      filters={
        <ReportFilterForm>
          <FilterField label={t("yearLabel")}>
            <input
              type="number"
              name="year"
              min={2020}
              max={2100}
              defaultValue={year}
              className={`${inputCls} w-[120px]`}
            />
          </FilterField>
        </ReportFilterForm>
      }
      stats={
        <>
          <StatTile label={t("statUvt")} value={money(uvtPesos * 100)} />
          <StatTile label={t("statPagos")} value={money(umbralPagosCents(uvtPesos))} />
          <StatTile label={t("statSaldos")} value={money(umbralSaldosCents(uvtPesos))} />
        </>
      }
      note={t("note")}
    >
      {/* Normativa aplicable al año gravable elegido */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-3 sm:p-4">
        <div className="text-sm font-semibold">{t("normTitle", { year })}</div>
        <p className="text-xs text-op-muted mt-0.5">{resolucionesDelAno(year)}</p>
        <ul className="mt-2 space-y-1 text-xs text-op-muted list-disc pl-5">
          <li>
            {t("normPagos", {
              uvt: CUANTIA_MENOR_PAGOS_UVT,
              amount: money(umbralPagosCents(uvtPesos)),
            })}
          </li>
          <li>
            {t("normSaldos", {
              uvt: CUANTIA_MENOR_SALDOS_UVT,
              amount: money(umbralSaldosCents(uvtPesos)),
            })}
          </li>
          <li>{t("normEnvio")}</li>
        </ul>
      </section>

      <IssuesPanel issues={report.issues} money={money} />

      {/* ================= Calculados de los documentos ================= */}
      <SectionTitle hint={t("sectionAutoHint")}>{t("sectionAuto")}</SectionTitle>

      <FormatCard f={F("1001")} year={year} blocked={blocked("1001")}>
        <Tbl
          cols={[
            ...txtCols([t("colDoc"), t("colTercero"), t("colConcept")]),
            ...numCols([t("colPago"), t("colIvaDed"), t("colIvaNoDed"), t("colRetefuente"), t("colReteIva")]),
          ]}
          rows={f["1001"].map((r) => [
            ...tercero(r.tercero),
            <span key="c" className="font-mono text-xs">{r.concept}</span>,
            money(r.pagoCents),
            money(r.idedCents),
            money(r.indedCents),
            money(r.retpCents),
            money(r.retaCents),
          ])}
          foot={totalRow(t("total"), [
            "",
            "",
            money(report.totals["1001"]),
            money(sum(f["1001"].map((r) => r.idedCents))),
            money(sum(f["1001"].map((r) => r.indedCents))),
            money(sum(f["1001"].map((r) => r.retpCents))),
            money(sum(f["1001"].map((r) => r.retaCents))),
          ])}
          empty={t("empty")}
        />
      </FormatCard>

      <FormatCard f={F("1005")} year={year} blocked={blocked("1005")}>
        <Tbl
          cols={[...txtCols([t("colDoc"), t("colTercero")]), ...numCols([t("colIva"), t("colIvaDev")])]}
          rows={f["1005"].map((r) => [...tercero(r.tercero), money(r.vimpCents), money(r.ivadeCents)])}
          foot={totalRow(t("total"), ["", money(report.totals["1005"]), ""])}
          empty={t("empty")}
        />
      </FormatCard>

      <FormatCard f={F("1006")} year={year} blocked={blocked("1006")}>
        <Tbl
          cols={[
            ...txtCols([t("colDoc"), t("colTercero")]),
            ...numCols([t("colIva"), t("colIvaDev"), t("colInc")]),
          ]}
          rows={f["1006"].map((r) => [
            ...tercero(r.tercero),
            money(r.ivaCents),
            money(r.ivaDevCents),
            money(r.incCents),
          ])}
          foot={totalRow(t("total"), [
            "",
            money(sum(f["1006"].map((r) => r.ivaCents))),
            "",
            money(sum(f["1006"].map((r) => r.incCents))),
          ])}
          empty={t("empty")}
        />
      </FormatCard>

      <FormatCard f={F("1007")} year={year} blocked={blocked("1007")}>
        <Tbl
          cols={[
            ...txtCols([t("colDoc"), t("colTercero"), t("colConcept")]),
            ...numCols([t("colIngreso"), t("colDevoluciones")]),
          ]}
          rows={f["1007"].map((r) => [
            ...tercero(r.tercero),
            <span key="c" className="font-mono text-xs">{r.concept}</span>,
            money(r.ibruCents),
            money(r.dredCents),
          ])}
          foot={totalRow(t("total"), ["", "", money(report.totals["1007"]), ""])}
          empty={t("empty")}
        />
      </FormatCard>

      {(["1008", "1009"] as const).map((code) => (
        <FormatCard key={code} f={F(code)} year={year} blocked={blocked(code)}>
          <Tbl
            cols={[...txtCols([t("colDoc"), t("colTercero")]), ...numCols([t("colSaldo")])]}
            rows={f[code].map((r) => [...tercero(r.tercero), money(r.saldoCents)])}
            foot={totalRow(t("total"), ["", money(report.totals[code])])}
            empty={t("empty")}
          />
        </FormatCard>
      ))}

      <FormatCard f={F("1011")} year={year} blocked={blocked("1011")}>
        <Tbl
          cols={[
            ...txtCols([t("colForm"), t("colConcept")]),
            ...numCols([t("colCount"), t("colDeclared")]),
          ]}
          rows={f["1011"].map((r) => [
            t.has(`form_${r.form}`) ? t(`form_${r.form}`) : r.form,
            r.concept ? (
              <span key="c" className="font-mono text-xs">{r.concept}</span>
            ) : (
              <span key="c" className="text-xs text-op-muted">{t("noConcept")}</span>
            ),
            String(r.count),
            money(r.valueCents),
          ])}
          foot={totalRow(t("total"), ["", "", money(report.totals["1011"])])}
          empty={t("empty")}
        />
      </FormatCard>

      {/* ================= Rentas de trabajo ================= */}
      <SectionTitle hint={t("sectionPayrollHint")}>{t("sectionPayroll")}</SectionTitle>

      <FormatCard f={F("2276")} year={year} blocked={false}>
        <Tbl
          cols={[
            ...txtCols([t("colEmployee")]),
            ...numCols([t("colSalario"), t("colOtros"), t("colSalud"), t("colPension"), t("colRetefuente")]),
          ]}
          rows={f["2276"].map((r) => [
            r.name,
            money(r.salarioCents),
            money(r.otrosCents),
            money(r.saludCents),
            money(r.pensionCents),
            money(r.retefuenteCents),
          ])}
          foot={totalRow(t("total"), [
            money(sum(f["2276"].map((r) => r.salarioCents))),
            money(sum(f["2276"].map((r) => r.otrosCents))),
            money(sum(f["2276"].map((r) => r.saludCents))),
            money(sum(f["2276"].map((r) => r.pensionCents))),
            money(sum(f["2276"].map((r) => r.retefuenteCents))),
          ])}
          empty={t("empty")}
        />
      </FormatCard>

      {/* ================= Captura manual ================= */}
      <SectionTitle hint={t("sectionManualHint")}>{t("sectionManual")}</SectionTitle>

      <FormatCard f={F("1010")} year={year} blocked={blocked("1010")}>
        <Tbl
          cols={[
            ...txtCols([t("colTercero"), t("colDoc")]),
            ...numCols([t("colPct"), t("colNominal"), t("colPrima")]),
            { label: "" },
          ]}
          rows={f["1010"].map((r) => {
            const [doc, name] = tercero(r.tercero);
            return [
              name,
              doc,
              pctFmt.format(r.sharePctBps / 10_000),
              money(r.nominalCents),
              money(r.premiumCents),
              <span key="x" className="no-print flex justify-end">
                <DeleteRowButton kind="shareholders" id={r.id} />
              </span>,
            ];
          })}
          empty={t("emptyManual")}
        />
        <ShareholderForm year={year} />
      </FormatCard>

      <FormatCard f={F("1012")} year={year} blocked={blocked("1012")}>
        <Tbl
          cols={[
            ...txtCols([t("colConcept"), t("colEntity"), t("colDoc")]),
            ...numCols([t("colValue")]),
            { label: "" },
          ]}
          rows={f["1012"].map((r) => {
            const [doc, name] = tercero(r.tercero);
            return [
              t.has(`concept_${r.concept}`) ? t(`concept_${r.concept}`) : r.concept,
              name,
              doc,
              money(r.valueCents),
              <span key="x" className="no-print flex justify-end">
                <DeleteRowButton kind="holdings" id={r.id} />
              </span>,
            ];
          })}
          empty={t("emptyManual")}
        />
        <HoldingForm year={year} />
      </FormatCard>
    </ReportShell>
  );
}

function sum(ns: number[]): number {
  return ns.reduce((s, n) => s + n, 0);
}

/** Encabezado de sección: agrupa las tarjetas por cómo se produce el formato. */
function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="pt-2">
      <h2 className="text-[11px] uppercase tracking-wider text-op-muted">{children}</h2>
      {hint && <p className="text-xs text-op-muted mt-0.5">{hint}</p>}
    </div>
  );
}

/** Panel de incidencias: qué tercero, en qué formato, por qué y dónde corregirlo. */
async function IssuesPanel({
  issues,
  money,
}: {
  issues: ExogenaIssue[];
  money: (c: number) => string;
}) {
  const t = await getTranslations("opExogena");
  return (
    <section className="rounded-2xl border border-op-border bg-op-surface p-3 sm:p-4">
      <div className="text-sm font-semibold">{t("issuesTitle")}</div>
      {issues.length === 0 ? (
        <p className="text-sm text-op-muted mt-1">{t("issuesNone")}</p>
      ) : (
        <>
          <p className="text-xs text-op-muted mt-1">{t("issuesIntro")}</p>
          <ul className="mt-3 divide-y divide-op-border/50 text-sm">
            {issues.map((i, idx) => (
              <li key={idx} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span
                  className={
                    i.blocking
                      ? "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-danger/10 text-danger"
                      : "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-op-bg border border-op-border text-op-muted"
                  }
                >
                  {i.blocking ? t("issueBlocking") : t("issueWarning")}
                </span>
                <span className="font-mono text-xs text-op-muted">{i.format}</span>
                <span className="font-medium">{i.name}</span>
                <span className="text-op-muted">{t(`issue_${i.code}`)}</span>
                <span className="font-mono tabular text-xs text-op-muted">{money(i.amountCents)}</span>
                {i.href && (
                  <Link href={i.href} className="no-print text-xs text-op-accent underline">
                    {t("fixLink")}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Tarjeta de un formato: código + nombre oficial + versión + origen + descarga. */
async function FormatCard({
  f,
  year,
  blocked,
  children,
}: {
  f: CatalogoFormato;
  year: number;
  blocked: boolean;
  children: ReactNode;
}) {
  const t = await getTranslations("opExogena");
  let action: ReactNode;
  if (!f.xml) {
    action = (
      <span className="inline-flex rounded-full px-3 py-1 text-xs bg-op-bg border border-op-border text-op-muted">
        {t("noXml")}
      </span>
    );
  } else if (blocked) {
    action = (
      <button type="button" disabled title={t("downloadBlocked")} className="mp-btn mp-btn--secondary mp-btn--sm">
        {t("downloadXml")}
      </button>
    );
  } else {
    action = (
      <a
        href={`/api/operator/reports/exogena/download?formato=${f.codigo}&year=${year}`}
        download
        className="mp-btn mp-btn--secondary mp-btn--sm"
      >
        {t("downloadXml")}
      </a>
    );
  }
  return (
    <section id={`f-${f.codigo}`} className="rounded-2xl border border-op-border bg-op-surface p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">
            <span className="font-mono text-op-accent mr-2">{f.codigo}</span>
            {t(`f${f.codigo}Name`)}
            <span className="font-mono text-xs font-normal text-op-muted ml-2">
              {t("versionLabel", { version: f.version })}
            </span>
          </h3>
          <p className="text-xs text-op-muted mt-0.5">{t(`f${f.codigo}Desc`)}</p>
        </div>
        <div className="no-print flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-op-muted">{t(`origin_${f.origen}`)}</span>
          {action}
        </div>
      </div>
      {blocked && f.xml && <p className="text-xs text-danger">{t("downloadBlocked")}</p>}
      {children}
    </section>
  );
}

/** Tabla simple del formato: columnas numéricas a la derecha, fila de totales, vacío. */
function Tbl({
  cols,
  rows,
  foot,
  empty,
}: {
  cols: { label: string; num?: boolean }[];
  rows: ReactNode[][];
  foot?: ReactNode[];
  empty: string;
}) {
  if (rows.length === 0) return <EmptyNote>{empty}</EmptyNote>;
  const th = "px-3 py-2 font-mono text-[9px] uppercase tracking-wider font-normal";
  const cell = (j: number) =>
    cols[j]?.num ? "px-3 py-1.5 text-right font-mono tabular whitespace-nowrap" : "px-3 py-1.5";
  return (
    <div className="overflow-x-auto rounded-xl border border-op-border">
      <table className="w-full text-sm min-w-[560px]">
        <thead>
          <tr className="border-b border-op-border bg-op-bg text-op-muted">
            {cols.map((c, j) => (
              <th key={j} className={`${th} ${c.num ? "text-right" : "text-left"}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-op-border/50">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={cell(j)}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot && (
          <tfoot>
            <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
              {foot.map((c, j) => (
                <td key={j} className={cell(j)}>
                  {c}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
