// Helpers compartidos por la lista, el formulario y el detalle de diferidos
// (cliente y servidor; sin dependencias de React).
import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import type {
  DeferredDetail,
  DeferredFormOptions,
  DeferredItemDto,
  DeferredScheduleRow,
} from "@/lib/erp/deferredQuery";

export const LIST_PATH = "/operator/contabilidad/diferidos";
export const ENTRY_PATH = "/operator/contabilidad/comprobantes";

export type { DeferredDetail, DeferredFormOptions, DeferredItemDto, DeferredScheduleRow };

/** Respuesta de `GET /api/operator/accounting/deferred`. */
export type DeferredListResponse = DeferredFormOptions & { items: DeferredItemDto[] };

/** "YYYY-MM" → "sep 2026" en el idioma del usuario (UTC, como el motor). */
export function monthLabel(month: string, locale: Locale): string {
  return formatDate(`${month}-01T12:00:00.000Z`, {
    locale,
    timeZone: "UTC",
    dateStyle: undefined,
    timeStyle: undefined,
    month: "short",
    year: "numeric",
  });
}
