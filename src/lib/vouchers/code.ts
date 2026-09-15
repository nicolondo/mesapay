import { randomBytes } from "node:crypto";

/**
 * Código de un bono: corto, legible y sin ambigüedad. Se dicta por teléfono
 * o se lee de un WhatsApp reenviado, así que el alfabeto NO tiene 0/O ni
 * 1/I. Formato mostrado: `SM-7K3Q-9X2A` (prefijo del comercio + 8
 * símbolos aleatorios en dos grupos de cuatro).
 *
 * En la base se guarda COMPACTO (`SM7K3Q9X2A`, único por comercio) y se
 * formatea al mostrar: el cuerpo aleatorio mide siempre 8, así que el
 * prefijo es todo lo que va antes y no hace falta guardar dónde cortar.
 * Al buscar se normaliza lo que tipeó la persona (mayúsculas, sin
 * guiones ni espacios) y se compara exacto.
 *
 * 32 símbolos ^ 8 ≈ 1,1 billones por comercio: la colisión es rarísima,
 * pero el índice único la atrapa igual y el emisor reintenta.
 */
export const VOUCHER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const VOUCHER_BODY_LENGTH = 8;

const STOPWORDS = new Set([
  "y", "e", "de", "del", "la", "el", "los", "las", "al", "a", "o", "en",
  "con", "por", "para", "un", "una", "and", "the", "of", "da", "do", "das",
  "dos", "em", "com",
]);

/**
 * Prefijo del comercio a partir de su nombre: iniciales de las palabras
 * con significado ("Son y Melona" → SM, "La Casa del Mar" → CM), máximo
 * tres letras. Con una sola palabra toma sus dos primeras letras
 * ("Andrés" → AN). Sin letras utilizables cae a "MP" (MESAPAY).
 */
export function voucherPrefix(name: string): string {
  const words = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const pool = meaningful.length > 0 ? meaningful : words;
  let letters = pool.map((w) => w[0]).join("").slice(0, 3);
  if (letters.length < 2 && pool[0]) letters = pool[0].slice(0, 2);
  if (letters.length < 2) return "MP";
  return letters;
}

/**
 * Genera un código nuevo. `random` es inyectable para tests
 * deterministas; por defecto `crypto.randomBytes`. Cada byte se reduce
 * módulo 32 — como 256 es múltiplo exacto de 32 la distribución es
 * uniforme. Devuelve la forma COMPACTA (la que se guarda).
 */
export function generateVoucherCode(
  prefix: string,
  random: (bytes: number) => Uint8Array = (n) => randomBytes(n),
): string {
  const bytes = random(VOUCHER_BODY_LENGTH);
  let body = "";
  for (let i = 0; i < VOUCHER_BODY_LENGTH; i++) {
    body += VOUCHER_ALPHABET[bytes[i] % VOUCHER_ALPHABET.length];
  }
  return `${normalizeVoucherCode(prefix)}${body}`;
}

/** Lo que tipeó la persona → forma compacta comparable con la guardada. */
export function normalizeVoucherCode(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** Forma compacta guardada → `SM-7K3Q-9X2A` para mostrar. */
export function formatVoucherCode(code: string): string {
  if (code.length <= VOUCHER_BODY_LENGTH) return code;
  const prefix = code.slice(0, -VOUCHER_BODY_LENGTH);
  const body = code.slice(-VOUCHER_BODY_LENGTH);
  return `${prefix}-${body.slice(0, 4)}-${body.slice(4)}`;
}

/** ¿Tiene la pinta de un código nuestro? (para no consultar la DB por basura) */
export function looksLikeVoucherCode(normalized: string): boolean {
  return /^[A-Z0-9]{2,3}[A-HJ-NP-Z2-9]{8}$/.test(normalized);
}
