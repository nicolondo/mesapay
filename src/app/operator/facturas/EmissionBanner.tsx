// Avisos de la emisión automática del comercio (ver
// `lib/dian/pendingEmission.ts`) y el texto de los motivos de bloqueo. Los
// avisos se muestran en la franja «Por atender» de /operator/facturas
// (`AttentionStrip`), junto a las rechazadas y las solicitudes tardías.
import { KNOWN_BLOCK_REASONS } from "@/lib/dian/invoiceRowView";

/** Resumen de la emisión automática del comercio. */
export type EmissionInfo = {
  waiting: number;
  blockedBy: string | null;
  blockedCount: number;
  numbersLeft: number | null;
};

/** Desde cuántos números restantes se avisa (= NUMBERS_LEFT_WARNING). */
export const NUMBERS_LEFT_WARNING = 500;

/**
 * Motivo de bloqueo (o de rechazo) → texto. Los códigos conocidos tienen
 * traducción en `opFacturas.blockReason_*`; el resto (las reglas que
 * devuelve la DIAN, en su propio texto) se muestra tal cual.
 */
export function blockReasonText(
  code: string,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  return KNOWN_BLOCK_REASONS.has(code) ? t(`blockReason_${code}`) : code;
}

/**
 * Qué avisar de la emisión, de lo más grave a lo menos:
 *
 *   · blocked    algo del COMERCIO frena las facturas (configuración
 *                incompleta, rango agotado): con emisión automática eso deja
 *                TODA la facturación parada sin que nadie apriete nada.
 *   · exhausted  se agotó el rango de la resolución.
 *   · lowNumbers la resolución se está quedando sin números.
 *   · queued     facturas en cola que se reintentan solas (sólo informa).
 */
export type EmissionNotice =
  | { kind: "blocked"; count: number; reason: string }
  | { kind: "exhausted" }
  | { kind: "lowNumbers"; count: number }
  | { kind: "queued"; count: number };

export function emissionNotices(emission: EmissionInfo): EmissionNotice[] {
  const out: EmissionNotice[] = [];
  if (emission.blockedCount > 0 && emission.blockedBy) {
    out.push({ kind: "blocked", count: emission.blockedCount, reason: emission.blockedBy });
  }
  if (emission.numbersLeft === 0) out.push({ kind: "exhausted" });
  else if (emission.numbersLeft != null && emission.numbersLeft < NUMBERS_LEFT_WARNING) {
    out.push({ kind: "lowNumbers", count: emission.numbersLeft });
  }
  const queued = emission.waiting - emission.blockedCount;
  if (queued > 0) out.push({ kind: "queued", count: queued });
  return out;
}
