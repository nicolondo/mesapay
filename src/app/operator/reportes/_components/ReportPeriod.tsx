"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { shiftPeriod } from "@/lib/erp/reports/period";

/**
 * Par desde/hasta de los reportes. Portado de zenith `report-period.tsx`.
 *
 * Las flechas ← → saltan un mes o un año completo y PRESERVAN el resto de
 * la query (nivel del balance, modo del diario, cuenta…) con
 * `router.replace` (no ensucia el historial). Los dos inputs van con
 * `name` para que el `<form method="get">` que los envuelve los mande al
 * pulsar «Aplicar»; el padre los remonta con `key` cuando cambia la URL.
 */
export function ReportPeriod({
  desde,
  hasta,
  step = "mes",
}: {
  desde: string;
  hasta: string;
  /** Paso de las flechas: mes completo (libros) o año completo (estados). */
  step?: "mes" | "año";
}) {
  const t = useTranslations("opReportes");
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [from, setFrom] = useState(desde);
  const [to, setTo] = useState(hasta);

  function shift(dir: -1 | 1) {
    const next = shiftPeriod({ desde, hasta }, step, dir);
    const params = new URLSearchParams(search.toString());
    params.set("desde", next.desde);
    params.set("hasta", next.hasta);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  const prevLabel = step === "año" ? t("prevYear") : t("prevMonth");
  const nextLabel = step === "año" ? t("nextYear") : t("nextMonth");
  const inputCls =
    "w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm";

  return (
    <div className="grid grid-cols-[auto_1fr_1fr_auto] items-end gap-2">
      <button
        type="button"
        aria-label={prevLabel}
        title={prevLabel}
        onClick={() => shift(-1)}
        className="mp-icobtn"
      >
        ←
      </button>
      <label className="min-w-0">
        <span className="block text-[11px] uppercase tracking-wider text-op-muted mb-1">
          {t("from")}
        </span>
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
        <span className="block text-[11px] uppercase tracking-wider text-op-muted mb-1">
          {t("to")}
        </span>
        <input
          type="date"
          name="hasta"
          value={to}
          min={from}
          onChange={(e) => setTo(e.target.value)}
          className={inputCls}
        />
      </label>
      <button
        type="button"
        aria-label={nextLabel}
        title={nextLabel}
        onClick={() => shift(1)}
        className="mp-icobtn"
      >
        →
      </button>
    </div>
  );
}
