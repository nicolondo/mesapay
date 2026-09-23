"use client";

import { displayOrderCode } from "@/lib/orderCode";
import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatDate, formatMoney, localeTag } from "@/lib/format";
import { currentMonthPeriod, shiftPeriod, type ReportPeriod } from "@/lib/erp/reports/period";
import {
  accountLabel,
  type CommissionPersonRow,
  type CommissionRow,
  type CommissionTotals,
} from "@/lib/waiterCommissions";

/** Lo que devuelve `GET /api/mesero/commissions`. */
export type MisComisionesData = {
  period: ReportPeriod;
  summary: CommissionPersonRow | null;
  detail: CommissionRow[];
  totals: CommissionTotals;
};

type Which = "this" | "prev";

/** Cuántas cuentas recientes se listan debajo del total. */
const RECENT = 5;

/**
 * «Mis comisiones» en /mesero/yo — la vista personal de zenith
 * `/mis-comisiones`, reducida al celular: comisión del mes (o del
 * anterior), lo cobrado, cuántas cuentas, el % y las últimas cuentas. El
 * servidor pre-llena el mes en curso; el mes anterior se pide al tocarlo y
 * se cachea.
 */
export function MisComisionesClient({
  currency,
  today,
  initial,
}: {
  currency: string;
  /** Hoy (`yyyy-mm-dd`) según el comercio: define «este mes». */
  today: string;
  initial: MisComisionesData;
}) {
  const t = useTranslations("opComisiones");
  const locale = useLocale() as Locale;
  const [which, setWhich] = useState<Which>("this");
  const [cache, setCache] = useState<Partial<Record<Which, MisComisionesData>>>({ this: initial });
  // Qué período falló al cargar (si falló). «Cargando» se deriva: sin dato
  // y sin error = en vuelo. Así el efecto sólo escribe estado desde los
  // callbacks del fetch, nunca de forma síncrona.
  const [errorFor, setErrorFor] = useState<Which | null>(null);

  const periods = useMemo(() => {
    const thisMonth = currentMonthPeriod(today);
    return { this: thisMonth, prev: shiftPeriod(thisMonth, "mes", -1) };
  }, [today]);

  useEffect(() => {
    if (cache[which]) return;
    const period = periods[which];
    let cancelled = false;
    fetch(`/api/mesero/commissions?desde=${period.desde}&hasta=${period.hasta}`)
      .then((r) =>
        r.ok ? (r.json() as Promise<MisComisionesData>) : Promise.reject(new Error("load_failed")),
      )
      .then((j) => {
        if (cancelled) return;
        setCache((c) => ({ ...c, [which]: j }));
        setErrorFor((e) => (e === which ? null : e));
      })
      .catch(() => {
        if (!cancelled) setErrorFor(which);
      });
    return () => {
      cancelled = true;
    };
  }, [which, cache, periods]);

  const data = cache[which];
  const failed = errorFor === which;
  const money = (c: number) => formatMoney(c, { currency, locale });
  const pctFmt = new Intl.NumberFormat(localeTag(locale), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const pct = (bps: number | null | undefined) =>
    bps == null ? t("pctVarious") : `${pctFmt.format(bps / 100)} %`;
  const labels = {
    table: (n: number) => t("accountTable", { n }),
    pickup: t("accountPickup"),
    manual: t("accountManual"),
  };
  // «septiembre de 2026»: sin dateStyle (Intl no deja mezclarlo con month/year).
  const monthLabel = (p: ReportPeriod) =>
    formatDate(`${p.desde}T00:00:00Z`, {
      locale,
      dateStyle: undefined,
      timeStyle: undefined,
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

  const segBtn = (on: boolean) =>
    "h-8 px-3 text-xs font-medium transition-colors " +
    (on ? "bg-ink text-bone" : "bg-paper text-ink hover:bg-ivory");

  return (
    <section className="rounded-2xl border border-hairline bg-paper p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="font-mono text-[10px] tracking-[0.15em] uppercase text-muted">
          {t("myTitle")}
        </div>
        <div
          role="group"
          aria-label={t("myTitle")}
          className="flex rounded-full border border-hairline overflow-hidden"
        >
          <button
            type="button"
            aria-pressed={which === "this"}
            onClick={() => setWhich("this")}
            className={segBtn(which === "this")}
          >
            {t("myThisMonth")}
          </button>
          <button
            type="button"
            aria-pressed={which === "prev"}
            onClick={() => setWhich("prev")}
            className={segBtn(which === "prev")}
          >
            {t("myPrevMonth")}
          </button>
        </div>
      </div>

      {failed ? (
        <p className="text-sm text-danger">{t("myLoadError")}</p>
      ) : !data ? (
        <p className="text-sm text-muted" aria-busy="true">
          {t("myLoading")}
        </p>
      ) : (
        <>
          <div className="font-display text-3xl tabular">{money(data.totals.commissionCents)}</div>
          <div className="text-xs text-muted">
            {t("myCommission")} · {monthLabel(data.period)}
          </div>

          <dl className="mt-3 grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-ivory border border-hairline p-2 text-center">
              <dt className="font-mono text-[9px] uppercase tracking-wider text-muted">
                {t("myCollected")}
              </dt>
              <dd className="text-sm font-medium tabular">{money(data.totals.baseCents)}</dd>
            </div>
            <div className="rounded-xl bg-ivory border border-hairline p-2 text-center">
              <dt className="font-mono text-[9px] uppercase tracking-wider text-muted">
                {t("myOrders")}
              </dt>
              <dd className="text-sm font-medium tabular">{data.totals.orders}</dd>
            </div>
            <div className="rounded-xl bg-ivory border border-hairline p-2 text-center">
              <dt className="font-mono text-[9px] uppercase tracking-wider text-muted">
                {t("myRate")}
              </dt>
              <dd className="text-sm font-medium tabular">
                {data.summary ? pct(data.summary.bps) : "—"}
              </dd>
            </div>
          </dl>

          {data.detail.length === 0 ? (
            <p className="mt-3 text-sm text-muted">{t("myEmpty")}</p>
          ) : (
            <div className="mt-3">
              <div className="font-mono text-[9px] uppercase tracking-wider text-muted mb-1">
                {t("myRecent")}
              </div>
              <ul className="divide-y divide-hairline">
                {data.detail
                  .slice(-RECENT)
                  .reverse()
                  .map((r) => (
                    <li key={r.orderId} className="flex items-center gap-2 py-1.5 text-sm">
                      <span className="text-muted whitespace-nowrap">
                        {formatDate(r.paidAt, { locale, dateStyle: "short", timeStyle: undefined, timeZone: "UTC" })}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {accountLabel(r, labels)}{" "}
                        <span className="font-mono text-[11px] text-muted" title={r.shortCode}>{displayOrderCode(r.shortCode)}</span>
                      </span>
                      <span className="font-medium tabular whitespace-nowrap">
                        {money(r.commissionCents)}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <p className="mt-3 text-[11px] text-muted">{t("myNote")}</p>
        </>
      )}
    </section>
  );
}
