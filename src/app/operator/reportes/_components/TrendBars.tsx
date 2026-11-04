"use client";

import { useLocale } from "next-intl";
import type { Locale } from "@/i18n/config";
import { formatMoney } from "@/lib/format";
import { ChartTooltip, useChartTooltip, useElementWidth } from "@/components/charts/useChartTooltip";
import { cx } from "./ReportCards";

/**
 * Mini-barras de los últimos períodos de una cifra (tesela de un reporte).
 * Una sola serie: sin leyenda (el título de la tesela la nombra). Barras en
 * el tono de fondo y la del período elegido en el acento, para que un salto
 * se vea de un vistazo; las negativas (un IVA a favor) bajan del cero.
 *
 * Al pasar el puntero, cada barra muestra su período y su cifra en el
 * globo; para el teclado y los lectores de pantalla el gráfico es UNA imagen
 * cuyo nombre lista todos los períodos con su cifra (seis paradas de
 * tabulador por tesela serían demasiadas: el comparativo con el período
 * anterior ya va como texto en la tesela). No se imprime (`no-print`).
 */
export function TrendBars({
  values,
  labels,
  currency,
  title,
}: {
  values: readonly number[];
  /** Rótulo de cada período («may 2026»), alineado con `values`. */
  labels: readonly string[];
  currency: string;
  /** Nombre accesible del gráfico. */
  title: string;
}) {
  const locale = useLocale() as Locale;
  const { ref, width } = useElementWidth<HTMLDivElement>(160);
  const tip = useChartTooltip(ref);
  if (values.length === 0) return null;
  const money = (c: number) => formatMoney(c, { currency, locale });
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const H = 32;
  const zero = (max / span) * H;
  const last = values.length - 1;
  return (
    <div ref={ref} className="no-print relative mt-2" onMouseLeave={tip.hide}>
      <div
        role="img"
        aria-label={`${title}: ${values.map((v, i) => `${labels[i] ?? ""} ${money(v)}`).join("; ")}`}
        className="flex h-8 items-stretch gap-[2px]"
      >
        {values.map((v, i) => {
          const h = v === 0 ? 0 : Math.max(2, (Math.abs(v) / span) * H);
          const top = v >= 0 ? zero - h : zero;
          const content = { title: labels[i] ?? "", rows: [{ value: money(v), label: title }] };
          return (
            <span
              key={i}
              aria-hidden
              onMouseMove={(e) => tip.show(e.clientX, e.clientY, content)}
              className="relative min-w-0 flex-1 cursor-default"
            >
              <span
                className={cx(
                  "absolute inset-x-0",
                  v >= 0 ? "rounded-t-[3px]" : "rounded-b-[3px]",
                  i === last ? "bg-op-accent" : "bg-[var(--op-border-2)]",
                )}
                style={{ top, height: h }}
              />
            </span>
          );
        })}
      </div>
      <span aria-hidden className="pointer-events-none absolute inset-x-0 h-px bg-op-border" style={{ top: zero }} />
      <ChartTooltip state={tip.state} containerWidth={width} />
    </div>
  );
}
