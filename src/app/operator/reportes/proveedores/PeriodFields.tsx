"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { SUPPLIER_REPORT_PRESETS, type SupplierReportPreset } from "@/lib/erp/reports/supplierReport";

const PRESET_KEY: Record<SupplierReportPreset, string> = {
  "12m": "period12m",
  "6m": "period6m",
  ytd: "periodYtd",
  rango: "periodRange",
};

const CONTROL = "w-full min-h-[40px] px-3 rounded-lg border border-op-border bg-op-bg text-sm";
const LABEL = "block text-[11px] uppercase tracking-wider text-op-muted mb-1";

/**
 * Período del informe de proveedores dentro del `<form method="get">`:
 * «Últimos 12 meses · Últimos 6 meses · Año en curso · Rango de meses».
 * Los dos meses del rango sólo existen (y sólo viajan en la URL) con
 * «Rango de meses» elegido; así un preset nunca choca con un rango viejo.
 * `type="month"` cae a texto `AAAA-MM` donde el navegador no lo soporta.
 */
export function PeriodFields({
  preset,
  fromMonth,
  toMonth,
  maxMonth,
}: {
  preset: SupplierReportPreset;
  fromMonth: string;
  toMonth: string;
  /** Mes en curso: tope de «Hasta». */
  maxMonth: string;
}) {
  const t = useTranslations("opSupplierReport");
  const [value, setValue] = useState<SupplierReportPreset>(preset);
  const month = (name: "desde" | "hasta", label: string, defaultValue: string) => (
    <label className="min-w-0 max-w-full">
      <span className={LABEL}>{label}</span>
      <input
        type="month"
        name={name}
        defaultValue={defaultValue}
        max={maxMonth}
        required
        pattern="\d{4}-\d{2}"
        placeholder={t("monthPlaceholder")}
        className={CONTROL}
      />
    </label>
  );
  return (
    <>
      <label className="min-w-0 max-w-full">
        <span className={LABEL}>{t("filterPeriod")}</span>
        <select
          name="periodo"
          value={value}
          onChange={(e) => setValue(e.target.value as SupplierReportPreset)}
          className={CONTROL}
        >
          {SUPPLIER_REPORT_PRESETS.map((p) => (
            <option key={p} value={p}>
              {t(PRESET_KEY[p])}
            </option>
          ))}
        </select>
      </label>
      {value === "rango" && (
        <div className="grid grid-cols-2 gap-3 md:contents">
          {month("desde", t("filterFrom"), fromMonth)}
          {month("hasta", t("filterTo"), toMonth)}
        </div>
      )}
    </>
  );
}
