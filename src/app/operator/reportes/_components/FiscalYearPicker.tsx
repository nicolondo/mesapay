"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * Selector de EJERCICIO (`?anio=`) de los estados por período. Portado de
 * zenith `fiscal-year-picker.tsx`: al elegir un año navega con
 * `router.replace` y BORRA `desde`/`hasta` de la URL, porque
 * `resolveReportPeriod` da prioridad a las fechas explícitas y el año
 * quedaría ignorado. El `<select>` va SIN `name`: no se envía con el
 * formulario de filtros (que manda desde/hasta) para no contradecirlo.
 * La opción vacía es «rango personalizado» (lo que muestre el par de
 * fechas).
 */
export function FiscalYearPicker({
  years,
  year,
}: {
  /** Años con asientos (descendentes), más el año en curso. */
  years: number[];
  /** Año seleccionado cuando el período es un ejercicio completo. */
  year: number | null;
}) {
  const t = useTranslations("opReportes");
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();

  function choose(value: string) {
    const params = new URLSearchParams(search.toString());
    params.delete("desde");
    params.delete("hasta");
    if (value) params.set("anio", value);
    else params.delete("anio");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <label className="min-w-0">
      <span className="block text-[11px] uppercase tracking-wider text-op-muted mb-1">
        {t("isYear")}
      </span>
      <select
        value={year == null ? "" : String(year)}
        onChange={(e) => choose(e.target.value)}
        className="w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm"
      >
        <option value="">{t("isYearCustom")}</option>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
    </label>
  );
}
