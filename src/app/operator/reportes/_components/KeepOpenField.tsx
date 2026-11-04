"use client";

import { useSearchParams } from "next/navigation";
import { OPEN_PARAM } from "@/lib/erp/reports/drillState";

/**
 * Campo oculto del formulario de filtros con lo desplegado (`?abrir=`): al
 * cambiar el período con «Aplicar», el reporte reabre los mismos renglones.
 * Es cliente porque lo abierto cambia en el navegador (`replaceState`) sin
 * que el servidor vuelva a pintar el formulario.
 */
export function KeepOpenField({ param = OPEN_PARAM }: { param?: string }) {
  const value = useSearchParams().get(param);
  return value ? <input type="hidden" name={param} value={value} /> : null;
}
