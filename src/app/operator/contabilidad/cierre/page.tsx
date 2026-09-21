import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { contabilidadTabHref } from "@/lib/erp/contabilidadTabs";
import { formatMonthLong, MIN_YEAR } from "@/lib/erp/cierrePeriodo";
import { fmtIsoDate } from "../../reportes/_components/fmt";
import { CloseMonthButton, ReopenMonthButton, YearClosingButton } from "./CierreActions";
import { loadCierrePage } from "./loadCierre";

export const dynamic = "force-dynamic";

const PATH = "/operator/contabilidad/cierre";
const TH = "px-3 py-2 text-left font-mono text-[9px] uppercase tracking-wider font-normal text-op-muted";
const TD = "px-3 py-2.5 align-middle";

/**
 * Cierre de período (port de zenith /contabilidad/cierre): el año mes a mes
 * con su estado (cerrado / abierto / futuro) y sus comprobantes, el botón
 * «Cerrar mes» sobre el próximo de la secuencia, «Reabrir último mes» y el
 * cierre del ejercicio. Todo el estado se lee server-side; los botones pegan
 * a las APIs que ya usan las pestañas Diario e Impuestos y refrescan.
 */
export default async function CierrePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string | string[] }>;
}) {
  const t = await getTranslations("opCierre");
  const tSettings = await getTranslations("opSettings");
  const locale = (await getLocale()) as Locale;
  const sp = await searchParams;
  const data = await loadCierrePage(sp.year);
  if (data === "no_restaurant") {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }
  const { status, config, closing, currency, currentYear } = data;
  const year = status.year;
  const money = (c: number) => formatMoney(c, { currency, locale });
  const monthLabel = (m: string) => formatMonthLong(m, locale);

  // ¿El próximo mes por cerrar cae fuera del año mostrado? Se avisa y se
  // ofrece saltar a ese año (si está dentro del rango del selector).
  const nextYear = status.nextToClose ? Number(status.nextToClose.slice(0, 4)) : null;
  const nextElsewhere =
    status.nextToClose != null && nextYear !== year && !status.months.some((m) => m.canClose);
  const canJump = nextYear != null && nextYear >= MIN_YEAR && nextYear <= currentYear + 1;

  const prevYear = year > MIN_YEAR ? year - 1 : null;
  const followingYear = year < currentYear + 1 ? year + 1 : null;

  return (
    <div className="p-6 max-w-4xl mx-auto w-full">
      <div className="mb-1">
        <div className="font-display text-3xl">{t("title")}</div>
        <Link
          href="/operator/contabilidad"
          className="text-xs text-op-muted hover:text-op-accent hover:underline"
        >
          {t("backToAccounting")}
        </Link>
      </div>
      <p className="text-sm text-op-muted mb-6">{t("intro")}</p>

      {/* Estado: último mes cerrado + próximo número */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-4 mb-6">
        <h2 className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-3">
          {t("statusTitle")}
        </h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-op-muted">{t("lastClosed")}</dt>
            <dd className="text-lg font-medium">
              {config.closedThrough ? monthLabel(config.closedThrough) : t("lastClosedNone")}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-op-muted">{t("nextVoucher")}</dt>
            <dd className="text-lg font-medium font-mono tabular">{config.nextVoucherNumber}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-op-muted">{t("numberingNote")}</p>
        {config.closedThrough && (
          <div className="mt-3">
            <ReopenMonthButton monthLabel={monthLabel(config.closedThrough)} />
          </div>
        )}
      </section>

      {/* Meses del año */}
      <section className="rounded-2xl border border-op-border bg-op-surface mb-6">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-op-border">
          {prevYear ? (
            <Link href={`${PATH}?year=${prevYear}`} aria-label={t("yearPrev")} className="mp-icobtn text-sm">
              {"◀"}
            </Link>
          ) : (
            <span aria-hidden className="mp-icobtn text-sm opacity-30">
              {"◀"}
            </span>
          )}
          <h2 className="text-sm font-medium">{t("monthsTitle", { year })}</h2>
          {followingYear ? (
            <Link
              href={`${PATH}?year=${followingYear}`}
              aria-label={t("yearNext")}
              className="mp-icobtn text-sm"
            >
              {"▶"}
            </Link>
          ) : (
            <span aria-hidden className="mp-icobtn text-sm opacity-30">
              {"▶"}
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-op-border">
                <th className={TH}>{t("colMonth")}</th>
                <th className={TH}>{t("colStatus")}</th>
                <th className={TH}>{t("colEntries")}</th>
                <th className={TH}>{t("colAction")}</th>
              </tr>
            </thead>
            <tbody>
              {status.months.map((m) => (
                <tr
                  key={m.month}
                  className={
                    "border-b border-op-border last:border-b-0 " +
                    (m.future ? "text-op-muted" : "")
                  }
                >
                  <td className={TD + " font-medium"}>{monthLabel(m.month)}</td>
                  <td className={TD}>
                    <span
                      className={
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium " +
                        (m.closed
                          ? "bg-ok/15 text-ok"
                          : m.future
                            ? "bg-op-bg text-op-muted"
                            : "bg-[#C98A2E]/15 text-[#7F5A1F]")
                      }
                    >
                      {m.closed ? t("stateClosed") : m.future ? t("stateFuture") : t("stateOpen")}
                    </span>
                  </td>
                  <td className={TD}>
                    <span>{t("entriesCount", { n: m.entries })}</span>
                    {m.entries > 0 && m.numbered > 0 && (
                      <span className="ml-2 text-xs text-op-muted">
                        {t("numberedCount", { n: m.numbered })}
                      </span>
                    )}
                  </td>
                  <td className={TD}>
                    {m.canClose && (
                      <CloseMonthButton month={m.month} monthLabel={monthLabel(m.month)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(nextElsewhere || status.nextToClose == null) && (
          <div className="px-4 py-3 border-t border-op-border text-xs text-op-muted flex flex-wrap items-center gap-2">
            {status.nextToClose == null ? (
              <>
                <span>{t("nothingToClose")}</span>
                <Link
                  href={contabilidadTabHref("diario")}
                  className="font-medium text-op-accent hover:underline"
                >
                  {t("linkJournal")}
                </Link>
              </>
            ) : (
              <>
                <span>{t("nextElsewhere", { month: monthLabel(status.nextToClose) })}</span>
                {canJump && (
                  <Link
                    href={`${PATH}?year=${nextYear}`}
                    className="font-medium text-op-accent hover:underline"
                  >
                    {t("goToYear", { year: nextYear })}
                  </Link>
                )}
              </>
            )}
          </div>
        )}
      </section>

      {/* Cierre del ejercicio */}
      <section className="rounded-2xl border border-op-border bg-op-surface p-4 mb-6">
        <h2 className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-3">
          {t("yearClosingTitle", { year })}
        </h2>
        <div className="text-sm">
          <div className="text-op-muted">
            {closing.exists && closing.dateISO
              ? t("yearClosingDone", { date: fmtIsoDate(closing.dateISO, locale) })
              : t("yearClosingNone")}
          </div>
          {closing.exists && (
            <div className="mt-1 font-medium">
              {closing.kind === "utilidad"
                ? t("yearClosingProfit") + ": " + money(closing.resultCents)
                : closing.kind === "perdida"
                  ? t("yearClosingLoss") + ": " + money(-closing.resultCents)
                  : t("yearClosingZero")}
            </div>
          )}
        </div>
        <p className="mt-3 text-xs text-op-muted">{t("yearClosingExplain", { year })}</p>
        {!status.allClosed && (
          <p className="mt-2 text-xs text-[#7F5A1F]">
            {t("yearClosingWarnOpen", { n: 12 - status.closedInYear })}
          </p>
        )}
        <div className="mt-4">
          <YearClosingButton year={year} exists={closing.exists} />
        </div>
      </section>

      {/* Enlaces */}
      <section>
        <h2 className="font-mono text-[10px] tracking-[0.15em] uppercase text-op-muted mb-2">
          {t("linksTitle")}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Link href="/operator/contabilidad/comprobantes" className="mp-btn mp-btn--ghost mp-btn--sm px-3">
            {t("linkVouchers")}
          </Link>
          <Link href={contabilidadTabHref("diario")} className="mp-btn mp-btn--ghost mp-btn--sm px-3">
            {t("linkJournal")}
          </Link>
          <Link href={contabilidadTabHref("impuestos")} className="mp-btn mp-btn--ghost mp-btn--sm px-3">
            {t("linkTaxes")}
          </Link>
        </div>
      </section>
    </div>
  );
}
