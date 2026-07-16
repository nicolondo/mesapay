/**
 * Extrae los datos "ricos" de un charge de tarjeta de Kushki para guardarlos
 * en columnas legibles de KushkiTransaction (marca, últimos 4, tipo, código de
 * aprobación, procesador...). Con `fullResponse:"v2"` Kushki devuelve todo esto
 * dentro de un bloque `details`; con respuestas más viejas algunos campos van
 * al top-level. Leemos defensivamente ambos lugares y toleramos ausencias.
 *
 * `raw` es el cuerpo ya parseado que guardamos en KushkiTransaction.raw
 * (ChargeResult.raw). No confiamos en su forma: puede ser el charge real de
 * producción, la respuesta del mock, o algo parcial — por eso todo es opcional.
 */
export type KushkiCardInfo = {
  cardBrand: string | null;
  cardLast4: string | null;
  cardType: string | null;
  cardBin: string | null;
  cardHolderName: string | null;
  approvalCode: string | null;
  processorName: string | null;
};

const EMPTY: KushkiCardInfo = {
  cardBrand: null,
  cardLast4: null,
  cardType: null,
  cardBin: null,
  cardHolderName: null,
  approvalCode: null,
  processorName: null,
};

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Devuelve el primer valor no-nulo entre varias claves candidatas. */
function pick(src: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const hit = str(src[k]);
    if (hit) return hit;
  }
  return null;
}

/** Deriva los últimos 4 de un número enmascarado tipo "445654XXXXXX0063". */
function last4From(masked: string | null): string | null {
  if (!masked) return null;
  const digits = masked.replace(/[^0-9]/g, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export function extractKushkiCardInfo(raw: unknown): KushkiCardInfo {
  if (!raw || typeof raw !== "object") return EMPTY;
  const top = raw as Record<string, unknown>;
  // El bloque rico vive en `details` (v2); si no está, usamos el top-level.
  const details =
    top.details && typeof top.details === "object"
      ? (top.details as Record<string, unknown>)
      : {};
  // Merge: primero details (más específico), luego top como fallback.
  const src: Record<string, unknown> = { ...top, ...details };

  const masked = pick(src, ["maskedCardNumber", "maskedCard", "cardNumber"]);
  const last4 =
    pick(src, ["lastFourDigits", "lastFour", "last4"]) ?? last4From(masked);

  return {
    cardBrand: pick(src, ["paymentBrand", "cardBrand", "brand"]),
    cardLast4: last4,
    cardType: pick(src, ["cardType", "type"]),
    cardBin: pick(src, ["binCard", "bin", "cardBin"]),
    cardHolderName: pick(src, ["cardHolderName", "holderName", "name"]),
    approvalCode: pick(src, ["approvalCode", "approvalNumber", "authorizationCode"]),
    processorName: pick(src, ["processorName", "processor", "acquirerBank"]),
  };
}
