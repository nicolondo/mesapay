"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { isoWeekNumber } from "@/lib/isoWeek";
import { unitLabel } from "@/lib/erp/reports/periodLabel";
import {
  periodKind,
  shiftPeriod,
  snapPeriod,
  todayIso,
  type PeriodKind,
  type PeriodStep,
  type ReportPeriod as Period,
} from "@/lib/erp/reports/period";

const KINDS: PeriodKind[] = ["semana", "mes", "año", "rango"];

const KIND_KEY = {
  semana: "periodKindWeek",
  mes: "periodKindMonth",
  año: "periodKindYear",
  rango: "periodKindCustom",
} as const;

const ARROW_KEY = {
  semana: { prev: "prevWeek", next: "nextWeek" },
  mes: { prev: "prevMonth", next: "nextMonth" },
  año: { prev: "prevYear", next: "nextYear" },
} as const;

/**
 * Selector de período de los reportes: modo «Semana · Mes · Año · Rango» y
 * flechas ← → que saltan una unidad completa. Portado de zenith
 * `report-period.tsx` y ampliado.
 *
 * El modo NO va en la URL: se deduce del par `desde`/`hasta`
 * (`periodKind`), así un enlace compartido abre con el mismo modo y las
 * rutas API no cambian. Al elegir un modo se salta a la unidad que
 * contiene hoy (o el final del rango, `snapPeriod`); las flechas y el modo
 * navegan con `router.replace` PRESERVANDO el resto de la query (nivel del
 * balance, modo del diario, cuenta…) y borrando `anio`, que las fechas
 * explícitas dejarían sin efecto.
 *
 * En los modos de unidad se muestra un rótulo legible («Octubre de 2026»,
 * «26 oct – 1 nov 2026») y las fechas viajan en campos ocultos para que el
 * `<form method="get">` que lo envuelve siga mandándolas al pulsar
 * «Aplicar» junto con los demás filtros. En «Rango» (o al tocar el rótulo)
 * aparecen los dos `<input type="date">`. El padre remonta el componente
 * con `key` cuando cambia la URL.
 */
export function ReportPeriod({
  desde,
  hasta,
  step = "mes",
}: {
  desde: string;
  hasta: string;
  /**
   * Paso de las flechas cuando el rango es libre (no es una unidad
   * completa): el mes (libros, impuestos) o el año (estados). Si el rango
   * ya es una semana, un mes o un año, las flechas saltan esa unidad.
   */
  step?: "mes" | "año";
}) {
  const t = useTranslations("opReportes");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [from, setFrom] = useState(desde);
  const [to, setTo] = useState(hasta);
  // «Rango» también cuando el usuario quiere editar a mano las fechas de
  // una unidad completa (toca el rótulo o el propio botón «Rango»).
  const [editing, setEditing] = useState(false);

  const period: Period = { desde, hasta };
  const kind = periodKind(period);
  const selected: PeriodKind = editing ? "rango" : kind;
  const arrowStep: PeriodStep = kind === "rango" ? step : kind;

  function go(next: Period) {
    const params = new URLSearchParams(search.toString());
    params.set("desde", next.desde);
    params.set("hasta", next.hasta);
    params.delete("anio");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function shift(dir: -1 | 1) {
    go(shiftPeriod(period, arrowStep, dir));
  }

  function choose(next: PeriodKind) {
    if (next === "rango") {
      setEditing(true);
      return;
    }
    setEditing(false);
    if (next !== kind) go(snapPeriod(period, next, todayIso()));
  }

  const prevLabel = t(ARROW_KEY[arrowStep].prev);
  const nextLabel = t(ARROW_KEY[arrowStep].next);
  const inputCls =
    "w-full min-w-0 min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm";
  const hintCls = "block text-[11px] uppercase tracking-wider text-op-muted mb-1";

  const prevButton = (
    <button
      type="button"
      aria-label={prevLabel}
      title={prevLabel}
      onClick={() => shift(-1)}
      className="mp-icobtn"
    >
      ←
    </button>
  );
  const nextButton = (
    <button
      type="button"
      aria-label={nextLabel}
      title={nextLabel}
      onClick={() => shift(1)}
      className="mp-icobtn"
    >
      →
    </button>
  );

  // En el celular los dos bloques (modo y fechas) van apilados a todo el
  // ancho; en md+ comparten fila con «Aplicar» dentro de `.report-filters`.
  return (
    <div className="flex w-full min-w-0 flex-col gap-2 md:w-auto md:flex-row md:items-end md:gap-3">
      <div className="min-w-0">
        <span className={hintCls}>{t("periodMode")}</span>
        {/* `.mp-seg` es inline-flex (globals.css); con w-full los cuatro
            botones se reparten el ancho en el celular (flex-1). */}
        <div className="mp-seg w-full md:w-auto" role="group" aria-label={t("periodMode")}>
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className="mp-seg__i flex-1 justify-center md:flex-none"
              data-active={selected === k ? "true" : undefined}
              aria-pressed={selected === k}
              onClick={() => choose(k)}
            >
              {t(KIND_KEY[k])}
            </button>
          ))}
        </div>
      </div>

      {selected === "rango" ? (
        // `minmax(0,1fr)` y no `1fr`: en un celular (358px útiles) los dos
        // <input type="date"> deben poder encoger por debajo de su ancho
        // intrínseco; con `1fr` (= minmax(auto,1fr)) la grilla desbordaba
        // la tarjeta de filtros y la página entera se desplazaba de lado.
        <div className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2 md:w-auto">
          {prevButton}
          <label className="min-w-0">
            <span className={hintCls}>{t("from")}</span>
            <input
              type="date"
              name="desde"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="min-w-0">
            <span className={hintCls}>{t("to")}</span>
            <input
              type="date"
              name="hasta"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
              className={inputCls}
            />
          </label>
          {nextButton}
        </div>
      ) : (
        <div className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 md:w-auto md:min-w-[280px]">
          {prevButton}
          <button
            type="button"
            onClick={() => setEditing(true)}
            title={t("periodEditDates")}
            className="min-h-[44px] min-w-0 truncate rounded-lg border border-op-border bg-op-bg px-3 text-center text-sm font-medium"
          >
            {/* La semana lleva su número ISO delante («Semana 44 · 26 oct –
                1 nov 2026») para citarla rápido con el contador. */}
            {kind === "semana"
              ? `${t("weekNumber", { n: isoWeekNumber(desde).week })} · ${unitLabel(kind, period, locale)}`
              : unitLabel(kind as PeriodStep, period, locale)}
          </button>
          <input type="hidden" name="desde" value={desde} />
          <input type="hidden" name="hasta" value={hasta} />
          {nextButton}
        </div>
      )}
    </div>
  );
}
