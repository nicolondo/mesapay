import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import {
  buildDailyBook,
  DAILY_BOOK_MODES,
  parseDailyBookMode,
  type DailyBook,
} from "@/lib/erp/reports/dailyBook";
import { formatVoucherNumber } from "@/lib/erp/reports/generalLedger";
import { makeSourceLabel } from "@/lib/erp/reports/labels";
import { dailyBookQuery, periodFromQuery } from "@/lib/erp/reports/params";
import { currentMonthPeriod, periodToUtcRange, todayIso } from "@/lib/erp/reports/period";
import { loadEntriesWithLines } from "@/lib/erp/reports/queries";
import { firstParam, reportGate } from "../_components/gate";
import { fmtIsoDate } from "../_components/fmt";
import { PrintButton } from "../_components/PrintButton";
import { ReportPeriod } from "../_components/ReportPeriod";
import {
  CsvButton,
  csvHref,
  EmptyNote,
  ReportCheck,
  ReportFilterForm,
  ReportShell,
  ReportTabs,
  StatTile,
} from "../_components/ReportShell";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const MODE_KEY = { detallado: "dbDetailed", resumido: "dbSummarized" } as const;

/**
 * Libro diario: comprobantes del período (por defecto el mes en curso) en
 * orden cronológico. Modo detallado (comprobante por comprobante) o
 * resumido (día × cuenta, D. 2649/93 art. 125). Se pinta en el servidor:
 * no hay interacción más allá de filtrar, exportar e imprimir.
 */
export default async function LibroDiarioPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, tErp, tSettings, locale] = await Promise.all([
    getTranslations("opReportes"),
    getTranslations("opErp"),
    getTranslations("opSettings"),
    getLocale(),
  ]);
  const gate = await reportGate();
  if (!gate) return <div className="p-6">{tSettings("noRestaurant")}</div>;

  const sp = await searchParams;
  const raw = {
    desde: firstParam(sp.desde),
    hasta: firstParam(sp.hasta),
    anio: firstParam(sp.anio),
    modo: firstParam(sp.modo),
  };
  const parsed = dailyBookQuery.safeParse(
    Object.fromEntries(Object.entries(raw).filter(([, v]) => v)),
  );
  const q = parsed.success ? parsed.data : {};
  const today = todayIso();
  const fallback = currentMonthPeriod(today);
  const period =
    periodFromQuery(q.desde || q.hasta || q.anio ? q : fallback, today) ??
    periodFromQuery(fallback, today)!;
  const mode = parseDailyBookMode(q.modo);
  const { from, to } = periodToUtcRange(period);

  const entries = await loadEntriesWithLines(gate.restaurantId, from, to);
  const book = buildDailyBook(entries, { mode });

  const loc = locale as Locale;
  const money = (c: number) => formatMoney(c, { currency: gate.currency, locale: loc });
  const sourceLabel = makeSourceLabel(tErp);
  const periodLabel = t("periodLabel", {
    from: fmtIsoDate(period.desde, loc),
    to: fmtIsoDate(period.hasta, loc),
  });
  const filterParams = { desde: period.desde, hasta: period.hasta, modo: mode };
  const tabHref = (m: string) =>
    `/operator/reportes/libro-diario?desde=${period.desde}&hasta=${period.hasta}&modo=${m}`;

  return (
    <ReportShell
      title={t("dbTitle")}
      description={t("dbSubtitle")}
      print={{
        businessName: gate.business.name,
        taxId: gate.business.taxId,
        title: t("dbTitle"),
        subtitle: `${periodLabel} · ${t(MODE_KEY[mode])}`,
      }}
      filters={
        <div className="space-y-3">
          <ReportFilterForm keep={{ modo: mode }}>
            <ReportPeriod key={`${period.desde}-${period.hasta}`} desde={period.desde} hasta={period.hasta} step="mes" />
          </ReportFilterForm>
          <ReportTabs
            label={t("dbMode")}
            options={DAILY_BOOK_MODES.map((m) => ({ key: m, label: t(MODE_KEY[m]) }))}
            active={mode}
            href={tabHref}
          />
        </div>
      }
      actions={
        <>
          <CsvButton href={csvHref("/api/operator/reports/daily-book", filterParams)} />
          <PrintButton />
        </>
      }
      stats={
        <>
          <StatTile label={t("dbStatEntries")} value={book.stats.entries} />
          <StatTile label={t("dbStatDebits")} value={money(book.stats.debitCents)} />
          <StatTile label={t("dbStatCredits")} value={money(book.stats.creditCents)} />
          {book.stats.voided > 0 && (
            <StatTile label={t("dbStatVoided")} value={book.stats.voided} tone="danger" />
          )}
        </>
      }
      statCols={book.stats.voided > 0 ? 4 : 3}
      note={t("dbNote")}
    >
      <div className="text-sm text-op-muted">
        {periodLabel} · {t(MODE_KEY[mode])}
      </div>

      {book.stats.entries === 0 ? (
        <EmptyNote>{t("noData")}</EmptyNote>
      ) : book.mode === "detallado" ? (
        <DetailedTable book={book} money={money} sourceLabel={sourceLabel} locale={loc} />
      ) : (
        <SummarizedTable book={book} money={money} locale={loc} />
      )}

      <ReportCheck
        description={t("balancedDesc", {
          debits: money(book.stats.debitCents),
          credits: money(book.stats.creditCents),
        })}
        ok={book.stats.balanced}
        okLabel={t("dbDoubleEntryOk")}
        failLabel={t("dbDoubleEntryFail", {
          amount: money(Math.abs(book.stats.debitCents - book.stats.creditCents)),
        })}
      />
    </ReportShell>
  );
}

const TH = "px-3 py-2 font-mono text-[9px] uppercase tracking-wider font-normal";
const NUM = "px-3 py-1.5 text-right font-mono tabular whitespace-nowrap";

async function DetailedTable({
  book,
  money,
  sourceLabel,
  locale,
}: {
  book: Extract<DailyBook, { mode: "detallado" }>;
  money: (c: number) => string;
  sourceLabel: (s: string) => string;
  locale: Locale;
}) {
  const t = await getTranslations("opReportes");
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-op-border text-op-muted">
              <th className={`${TH} text-left`}>{t("colAccount")}</th>
              <th className={`${TH} text-left`}>{t("colAccountName")}</th>
              <th className={`${TH} text-right`}>{t("colDebit")}</th>
              <th className={`${TH} text-right`}>{t("colCredit")}</th>
            </tr>
          </thead>
          <tbody>
            {book.entries.map((e) => (
              <EntryRows key={e.id} entry={e} money={money} sourceLabel={sourceLabel} locale={locale} />
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
              <td className="px-3 py-2" colSpan={2}>
                {t("total")}
              </td>
              <td className={NUM}>{money(book.stats.debitCents)}</td>
              <td className={NUM}>{money(book.stats.creditCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

async function EntryRows({
  entry: e,
  money,
  sourceLabel,
  locale,
}: {
  entry: Extract<DailyBook, { mode: "detallado" }>["entries"][number];
  money: (c: number) => string;
  sourceLabel: (s: string) => string;
  locale: Locale;
}) {
  const t = await getTranslations("opReportes");
  return (
    <>
      {/* Banda del comprobante: número, origen, fecha, descripción y totales. */}
      <tr className={`border-t border-op-border bg-op-bg/60 ${e.voided ? "opacity-60" : ""}`}>
        <td className="px-3 py-2" colSpan={2}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
            <span className="font-mono font-semibold">
              {formatVoucherNumber(e.voucherNumber) ?? (
                <span className="text-op-muted font-normal">{t("unnumbered")}</span>
              )}
            </span>
            <span className="rounded-full border border-op-border px-1.5 text-[10px] text-op-muted">
              {sourceLabel(e.source)}
            </span>
            <span className="text-xs text-op-muted whitespace-nowrap">{fmtIsoDate(e.date, locale)}</span>
            {e.voided && (
              <span className="rounded-full bg-danger/10 px-1.5 text-[10px] font-semibold text-danger">
                {t("voided")}
              </span>
            )}
            {e.memo && <span className="text-sm truncate">{e.memo}</span>}
          </div>
        </td>
        <td className={`${NUM} font-semibold`}>{money(e.debitCents)}</td>
        <td className={`${NUM} font-semibold`}>{money(e.creditCents)}</td>
      </tr>
      {e.lines.map((l, i) => (
        <tr key={`${e.id}-${i}`} className={`border-t border-op-border/40 ${e.voided ? "opacity-60 line-through" : ""}`}>
          <td className="px-3 py-1.5 font-mono text-xs text-op-muted whitespace-nowrap">
            <span className={l.debitCents > 0 ? "" : "pl-4"}>{l.accountCode}</span>
          </td>
          <td className="px-3 py-1.5 min-w-0">
            <span className="truncate">{l.accountName}</span>
            {l.memo && <span className="ml-2 text-xs text-op-muted">{l.memo}</span>}
          </td>
          <td className={NUM}>{l.debitCents ? money(l.debitCents) : ""}</td>
          <td className={NUM}>{l.creditCents ? money(l.creditCents) : ""}</td>
        </tr>
      ))}
    </>
  );
}

async function SummarizedTable({
  book,
  money,
  locale,
}: {
  book: Extract<DailyBook, { mode: "resumido" }>;
  money: (c: number) => string;
  locale: Locale;
}) {
  const t = await getTranslations("opReportes");
  return (
    <div className="rounded-2xl border border-op-border bg-op-surface overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[560px]">
          <thead>
            <tr className="border-b border-op-border text-op-muted">
              <th className={`${TH} text-left`}>{t("colAccount")}</th>
              <th className={`${TH} text-left`}>{t("colName")}</th>
              <th className={`${TH} text-right`}>{t("colDebits")}</th>
              <th className={`${TH} text-right`}>{t("colCredits")}</th>
            </tr>
          </thead>
          <tbody>
            {book.days.map((d) => (
              <DayRows key={d.date} day={d} money={money} locale={locale} />
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-op-border font-semibold bg-op-bg">
              <td className="px-3 py-2" colSpan={2}>
                {t("total")}
              </td>
              <td className={NUM}>{money(book.stats.debitCents)}</td>
              <td className={NUM}>{money(book.stats.creditCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

async function DayRows({
  day: d,
  money,
  locale,
}: {
  day: Extract<DailyBook, { mode: "resumido" }>["days"][number];
  money: (c: number) => string;
  locale: Locale;
}) {
  const t = await getTranslations("opReportes");
  return (
    <>
      <tr className="border-t border-op-border bg-op-bg/60">
        <td className="px-3 py-2 font-semibold" colSpan={2}>
          {fmtIsoDate(d.date, locale)}
          <span className="ml-2 text-xs font-normal text-op-muted">{t("dbDayTotal")}</span>
        </td>
        <td className={`${NUM} font-semibold`}>{money(d.debitCents)}</td>
        <td className={`${NUM} font-semibold`}>{money(d.creditCents)}</td>
      </tr>
      {d.rows.map((r) => (
        <tr key={`${d.date}-${r.accountCode}`} className="border-t border-op-border/40">
          <td className="px-3 py-1.5 font-mono text-xs text-op-muted whitespace-nowrap">{r.accountCode}</td>
          <td className="px-3 py-1.5 min-w-0">{r.accountName}</td>
          <td className={NUM}>{r.debitCents ? money(r.debitCents) : ""}</td>
          <td className={NUM}>{r.creditCents ? money(r.creditCents) : ""}</td>
        </tr>
      ))}
    </>
  );
}
