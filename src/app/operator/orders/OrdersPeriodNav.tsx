"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { Locale } from "@/i18n/config";
import { addDaysIso } from "@/lib/bogota";
import { isoWeekNumber } from "@/lib/isoWeek";
import {
  isIsoDate,
  periodIncludes,
  periodKindWithDay,
  shiftByLength,
  shiftPeriod,
  snapPeriod,
  type ReportPeriod as Period,
} from "@/lib/erp/reports/period";
import { monthLabel, rangeLabel, weekdayDateLabel } from "@/lib/erp/reports/periodLabel";
import { ordersHref, type OrdersView } from "@/lib/orders/ordersView";
import { OrdersDayPicker } from "./OrdersDayPicker";

type Kind = ReturnType<typeof periodKindWithDay>;

const KINDS = ["día", "semana", "mes", "rango"] as const satisfies readonly Kind[];

const KIND_KEY = {
  día: "periodKindDay",
  semana: "periodKindWeek",
  mes: "periodKindMonth",
  rango: "periodKindRange",
} as const;

const ARROW_KEY = {
  día: { prev: "prevDay", next: "nextDay" },
  semana: { prev: "prevWeek", next: "nextWeek" },
  mes: { prev: "prevMonth", next: "nextMonth" },
  rango: { prev: "prevRange", next: "nextRange" },
} as const;

/** Rótulo del período: «Hoy», «Ayer», «sáb, 1 nov», «Semana 45 · 2 – 8 nov 2026»… */
export function periodNavLabel(
  period: Period,
  today: string,
  locale: Locale,
  t: (key: "today" | "yesterday" | "weekNumber", values?: { n: number }) => string,
): string {
  const kind = periodKindWithDay(period);
  // El año de hoy se sobreentiende («Semana 45 · 2 – 8 nov»): en el
  // celular el rótulo tiene que caber entre las flechas.
  const year = period.desde.slice(0, 4) !== today.slice(0, 4) || period.hasta.slice(0, 4) !== today.slice(0, 4);
  if (kind === "día") {
    if (period.desde === today) return t("today");
    if (period.desde === addDaysIso(today, -1)) return t("yesterday");
    return weekdayDateLabel(period.desde, locale, today);
  }
  if (kind === "semana") {
    return `${t("weekNumber", { n: isoWeekNumber(period.desde).week })} · ${rangeLabel(period, locale, { year })}`;
  }
  if (kind === "mes") return monthLabel(period.desde, locale);
  return rangeLabel(period, locale, { year });
}

/**
 * Navegador de período de la lista de Órdenes: «Día · Semana · Mes ·
 * Rango», flechas ← → que saltan una unidad completa (un rango libre salta
 * su propio largo) y «Volver a hoy» cuando el período no incluye hoy.
 *
 * Todo en días de NEGOCIO (`today` llega del servidor con el corte del
 * comercio) y con la misma matemática que los reportes (`period.ts`:
 * semanas lunes a domingo, número ISO). Cada salto es un enlace con
 * `desde`/`hasta` en la URL —atrás/adelante, recargar y compartir
 * funcionan—, conserva el estado y la búsqueda, vuelve a la página 1 y no
 * lleva la vista arriba de todo (`scroll={false}`).
 *
 * El padre remonta el componente con `key` cuando cambia el período, para
 * cerrar el editor de fechas.
 */
export function OrdersPeriodNav({ view, today }: { view: OrdersView; today: string }) {
  const t = useTranslations("opOrders");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const period = view.period;
  const kind = periodKindWithDay(period);
  const [editing, setEditing] = useState(kind === "rango");
  const [choosingDay, setChoosingDay] = useState(false);
  const selected: Kind = editing ? "rango" : kind;

  const href = (next: Period) => ordersHref(view, today, { period: next });
  const shift = (dir: -1 | 1) =>
    kind === "rango" ? shiftByLength(period, dir) : shiftPeriod(period, kind, dir);
  const prev = shift(-1);
  const next = shift(1);
  // Al futuro no hay órdenes: la flecha se apaga cuando el siguiente
  // período empezaría después de hoy.
  const nextDisabled = next.desde > today;
  const awayFromToday = !periodIncludes(period, today);
  const label = periodNavLabel(period, today, locale, t);

  function applyRange(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const a = String(data.get("desde") ?? "");
    const b = String(data.get("hasta") ?? "");
    if (!isIsoDate(a) || !isIsoDate(b)) return;
    router.push(href(a <= b ? { desde: a, hasta: b } : { desde: b, hasta: a }), { scroll: false });
  }

  const prevLabel = t(ARROW_KEY[kind].prev);
  const nextLabel = t(ARROW_KEY[kind].next);
  const hintCls = "block font-mono text-[9px] tracking-[0.14em] uppercase text-op-muted mb-1";
  const inputCls =
    "h-11 w-full min-w-0 px-3 rounded-lg border border-op-border bg-op-bg text-sm lg:h-10";

  return (
    <div className="flex w-full min-w-0 flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center lg:gap-3">
      {/* `.mp-seg` es inline-flex; con w-full los cuatro modos se reparten
          el ancho en el celular. */}
      <div className="mp-seg w-full lg:w-auto" role="group" aria-label={t("filterPeriod")}>
        {KINDS.map((k) =>
          k === "rango" ? (
            <button
              key={k}
              type="button"
              className="mp-seg__i flex-1 justify-center lg:flex-none"
              data-active={selected === k ? "true" : undefined}
              aria-pressed={selected === k}
              onClick={() => setEditing(true)}
            >
              {t(KIND_KEY[k])}
            </button>
          ) : (
            <Link
              key={k}
              href={href(snapPeriod(period, k, today))}
              prefetch={false}
              scroll={false}
              className="mp-seg__i flex-1 justify-center lg:flex-none"
              data-active={selected === k ? "true" : undefined}
              aria-current={selected === k ? "true" : undefined}
              onClick={() => setEditing(false)}
            >
              {t(KIND_KEY[k])}
            </Link>
          ),
        )}
      </div>

      <div className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 lg:w-auto lg:min-w-[300px]">
        <Link
          href={href(prev)}
          prefetch={false}
          scroll={false}
          aria-label={prevLabel}
          title={prevLabel}
          className="mp-icobtn"
        >
          {"←"}
        </Link>
        <button
          type="button"
          onClick={(event) => {
            // Safari does not focus buttons on touch; restore this trigger on Escape.
            event.currentTarget.focus({ preventScroll: true });
            setChoosingDay(true);
          }}
          title={t("dayPickerTitle")}
          aria-haspopup="dialog"
          aria-expanded={choosingDay}
          className="h-11 min-w-0 truncate rounded-lg border border-op-border bg-op-bg px-3 text-center text-sm font-medium"
        >
          <span aria-live="polite">{label}</span>
        </button>
        {nextDisabled ? (
          <span
            aria-disabled="true"
            aria-label={nextLabel}
            title={nextLabel}
            className="mp-icobtn pointer-events-none opacity-40"
          >
            {"→"}
          </span>
        ) : (
          <Link
            href={href(next)}
            prefetch={false}
            scroll={false}
            aria-label={nextLabel}
            title={nextLabel}
            className="mp-icobtn"
          >
            {"→"}
          </Link>
        )}
      </div>

      {awayFromToday && (
        <Link
          href={href({ desde: today, hasta: today })}
          prefetch={false}
          scroll={false}
          className="mp-btn mp-btn--secondary mp-btn--sm w-full lg:w-auto"
        >
          {t("backToToday")}
        </Link>
      )}

      {editing && (
        // Rango libre: un GET normal con las dos fechas (sin JavaScript
        // también funciona); el estado y la búsqueda viajan ocultos.
        <form
          action="/operator/orders"
          method="get"
          onSubmit={applyRange}
          className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-end gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:basis-full lg:max-w-xl"
        >
          {view.status !== "all" && <input type="hidden" name="status" value={view.status} />}
          {view.source !== "all" && <input type="hidden" name="source" value={view.source} />}
          {view.source === "tables" && view.tableId && <input type="hidden" name="tableId" value={view.tableId} />}
          {view.q && <input type="hidden" name="q" value={view.q} />}
          {view.credit && <input type="hidden" name="credito" value="1" />}
          <label className="min-w-0">
            <span className={hintCls}>{t("rangeFrom")}</span>
            <input
              type="date"
              name="desde"
              defaultValue={period.desde}
              max={today}
              required
              className={inputCls}
            />
          </label>
          <label className="min-w-0">
            <span className={hintCls}>{t("rangeTo")}</span>
            <input
              type="date"
              name="hasta"
              defaultValue={period.hasta}
              max={today}
              required
              className={inputCls}
            />
          </label>
          <button
            type="submit"
            className="mp-btn mp-btn--primary mp-btn--sm col-span-2 sm:col-span-1"
          >
            {t("rangeApply")}
          </button>
        </form>
      )}
      {choosingDay && (
        <OrdersDayPicker
          selectedDate={snapPeriod(period, "día", today).desde}
          today={today}
          onClose={() => setChoosingDay(false)}
          onSelect={(day) => {
            setChoosingDay(false);
            setEditing(false);
            router.push(href({ desde: day, hasta: day }), { scroll: false });
          }}
        />
      )}
    </div>
  );
}
