import type { Locale } from "@/i18n/config";
import { formatDate } from "@/lib/format";

/** Parámetro de la URL con la conversación abierta: /operator/insights?c=<id>. */
export const CONVERSATION_PARAM = "c";

// Los ids son cuid de Prisma (25 caracteres alfanuméricos). Se acepta algo
// de holgura, pero nunca caracteres raros: un `?c=` manipulado no llega a la
// API ni se vuelve a escribir en la URL.
const ID_RE = /^[a-z0-9]{10,40}$/i;

type SearchLike = { get(name: string): string | null } | string | null | undefined;

function toParams(search: SearchLike): URLSearchParams {
  if (typeof search === "string") return new URLSearchParams(search);
  return new URLSearchParams(search?.toString() ?? "");
}

/** Id de la conversación en `?c=`, o null si falta o no tiene pinta de id. */
export function readConversationId(search: SearchLike): string | null {
  const raw = (typeof search === "string" ? toParams(search) : search)?.get(CONVERSATION_PARAM)?.trim();
  return raw && ID_RE.test(raw) ? raw : null;
}

/**
 * Ruta con `?c=` fijado (o quitado si `id` es null) conservando el resto de
 * la query. Es lo que se le pasa a `router.replace`.
 */
export function conversationHref(pathname: string, search: SearchLike, id: string | null): string {
  const params = toParams(search);
  if (id) params.set(CONVERSATION_PARAM, id);
  else params.delete(CONVERSATION_PARAM);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

/** "YYYY-MM-DD" de `d` en `timeZone`. */
function localDay(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Fecha corta de una conversación en la lista: sólo la hora si fue hoy,
 * «2 nov» si fue este año y la fecha corta si fue otro año. `timeZone` es
 * la del navegador del operador (está en el local); si no se pasa, la del
 * resto del panel (Bogotá).
 */
export function formatConversationDate(
  date: Date | string,
  opts: { locale: Locale; now?: Date; timeZone?: string },
): string {
  const d = new Date(date);
  const now = opts.now ?? new Date();
  const timeZone = opts.timeZone ?? "America/Bogota";
  const day = localDay(d, timeZone);
  const today = localDay(now, timeZone);
  // `formatDate` trae dateStyle/timeStyle por defecto; Intl no permite
  // mezclarlos con month/day, por eso se anulan explícitamente.
  if (day === today) {
    return formatDate(d, { locale: opts.locale, timeZone, dateStyle: undefined, timeStyle: "short" });
  }
  if (day.slice(0, 4) === today.slice(0, 4)) {
    return formatDate(d, {
      locale: opts.locale,
      timeZone,
      dateStyle: undefined,
      timeStyle: undefined,
      month: "short",
      day: "numeric",
    });
  }
  return formatDate(d, { locale: opts.locale, timeZone, dateStyle: "short", timeStyle: undefined });
}
