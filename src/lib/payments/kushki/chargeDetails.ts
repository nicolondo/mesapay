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

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * RID del AID EMV (los primeros 10 hex) → franquicia. El `cardData` del
 * Sunmi no trae la marca: trae el `aid` de la aplicación EMV con la que
 * se cobró, y el RID identifica a la red (EMVCo). Solo las que operan
 * acá; un AID desconocido devuelve null antes que adivinar.
 */
const EMV_RID_BRAND: ReadonlyArray<[rid: string, brand: string]> = [
  ["A000000003", "VISA"],
  ["A000000004", "MASTERCARD"], // incluye Maestro (mismo RID)
  ["A000000025", "AMEX"],
  ["A000000065", "JCB"],
  ["A000000152", "DISCOVER"], // incluye Diners (red Discover)
];

function brandFromAid(aid: string | null): string | null {
  if (!aid) return null;
  const hex = aid.toUpperCase().replace(/[^0-9A-F]/g, "");
  const hit = EMV_RID_BRAND.find(([rid]) => hex.startsWith(rid));
  return hit ? hit[1] : null;
}

/**
 * Último recurso: el primer dígito del PAN enmascarado, SOLO si es un
 * dígito visible (4 = Visa, 5 = Mastercard, 3 = Amex).
 */
function brandFromPanDigit(masked: string | null): string | null {
  const first = masked?.trim()[0];
  if (first === "4") return "VISA";
  if (first === "5") return "MASTERCARD";
  if (first === "3") return "AMEX";
  return null;
}

export function extractKushkiCardInfo(raw: unknown): KushkiCardInfo {
  if (!raw || typeof raw !== "object") return EMPTY;
  const top = raw as Record<string, unknown>;
  // Dónde puede vivir el bloque rico según el camino del cobro:
  //   · en línea con `fullResponse:"v2"`: `details`;
  //   · DATÁFONO en la nube (sync charge / búsqueda): el detalle viene con
  //     OTRAS claves (`authCode`, `cardData`, `responseCode`…) al top-level
  //     y/o dentro de `rawResponse` — la factura FESM8648 salió sin
  //     franquicia/últimos 4/aprobación porque esta extracción solo
  //     entendía la forma del cobro en línea.
  // Merge del menos específico al más: top ← rawResponse ← details.
  const src: Record<string, unknown> = {
    ...top,
    ...obj(top.rawResponse),
    ...obj(top.details),
  };
  // `cardData` del terminal (forma REAL vista en prod, 2 filas del Sunmi):
  // un OBJETO { tc, aid, bin, cvm, pan, arqc, bank, entryMode,
  // cardHolderName } — el `pan` viene enmascarado y NUNCA se persiste (de
  // cualquier forma enmascarada solo se derivan los últimos 4), `bank` es
  // el EMISOR (no la franquicia: jamás se usa como brand). También se
  // tolera un string enmascarado u otras claves (maskedPan…): defensivo.
  const cardData = src.cardData ?? src.card_data;
  const card = obj(cardData);

  const masked =
    pick({ ...src, ...card }, ["maskedCardNumber", "maskedCard", "maskedPan", "cardNumber"]) ??
    pick(card, ["pan"]) ??
    (typeof cardData === "string" ? cardData : null);
  const last4 =
    pick({ ...src, ...card }, ["lastFourDigits", "lastFour", "last4"]) ?? last4From(masked);

  const from = (keys: string[]) => pick(card, keys) ?? pick(src, keys);
  return {
    // La franquicia, en orden: una clave explícita de marca (cobro en
    // línea, o si `rawResponse` la trajera), el RID del AID EMV del
    // terminal, y como último recurso el primer dígito visible del PAN.
    cardBrand:
      from(["paymentBrand", "cardBrand", "brand", "franchise"]) ??
      brandFromAid(from(["aid"])) ??
      brandFromPanDigit(masked),
    cardLast4: last4,
    // "type"/"name" genéricos SOLO dentro de `cardData`: al top-level el
    // terminal los usa para otra cosa ({"type":"TERMINAL-SUNMI"…}).
    cardType: pick(card, ["cardType", "type"]) ?? pick(src, ["cardType"]),
    cardBin: from(["binCard", "bin", "cardBin"]),
    cardHolderName: pick(card, ["cardHolderName", "holderName", "name"]) ?? pick(src, ["cardHolderName", "holderName"]),
    approvalCode: pick(src, ["approvalCode", "approvalNumber", "authorizationCode", "authCode", "auth_code", "approval_code"]),
    processorName: pick(src, ["processorName", "processor", "acquirerBank"]),
  };
}

/**
 * La referencia de la transacción en Kushki, para cruzar con el extracto.
 * El datáfono la manda como `transactionReference` (a veces dentro de
 * `rawResponse`); el cobro en línea como `transactionReference` o
 * `ticketNumber`. null si el raw no trae ninguna.
 */
export function extractKushkiReference(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const top = raw as Record<string, unknown>;
  const src: Record<string, unknown> = {
    ...top,
    ...obj(top.rawResponse),
    ...obj(top.details),
  };
  return pick(src, ["transactionReference", "transaction_reference", "ticketNumber", "ticket_number"]);
}
