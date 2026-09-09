/**
 * Codificación de texto para impresoras térmicas ESC/POS.
 *
 * ── El problema ───────────────────────────────────────────────────────
 * Una térmica NO habla UTF-8. Habla bytes de 8 bits interpretados contra
 * una "code page" que se selecciona con `ESC t n`. Si uno le manda UTF-8
 * crudo, "Ñoquis con champiñón" sale como "Ã±oquis con champiÃ±Ã³n" —
 * ilegible para el cocinero. Esto es Colombia: las eñes y las tildes no
 * son un caso borde, son el caso normal.
 *
 * ── Por qué CP850 y no CP437 ──────────────────────────────────────────
 * CP437 (la default de fábrica de casi todas) tiene á é í ó ú ñ, pero NO
 * tiene ã õ Ã Õ. MESAPAY es trilingüe (es/en/pt) y una comanda en
 * portugués con "Pão de queijo" saldría rota. CP850 (Multilingual Latin-1)
 * cubre español Y portugués completos, y la soportan tanto las Epson como
 * las genéricas chinas que es lo que hay instalado en las cocinas.
 *
 * ── Y lo que no entra en CP850 ────────────────────────────────────────
 * Se translitera en vez de imprimir basura: comillas tipográficas → ",
 * guion largo → -, … → ..., y cualquier letra acentuada rara pierde el
 * acento vía NFD ("Đ" → "D"). Los emoji se DESCARTAN en silencio en vez
 * de convertirse en "?" — un mesero que escribe "sin cebolla 🙏" no debe
 * ensuciar la comanda con signos de pregunta.
 */

/** `ESC t 2` — selecciona PC850 (Multilingual). */
export const CODE_PAGE_CP850 = 2;

/**
 * Tabla CP850 para 0x80–0xFF (128 caracteres exactos, el índice 0 es el
 * byte 0x80). Los caracteres de dibujo de caja (░ │ ╣ …) están porque son
 * parte de la code page. Los invisibles van escapados a propósito para
 * que nadie los borre sin darse cuenta al editar este archivo.
 */
export const CP850_HIGH =
  "ÇüéâäàåçêëèïîìÄÅ" + // 0x80–0x8F
  "ÉæÆôöòûùÿÖÜø£Ø×ƒ" + // 0x90–0x9F
  "áíóúñÑªº¿®¬½¼¡«»" + // 0xA0–0xAF
  "░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐" + // 0xB0–0xBF
  "└┴┬├─┼ãÃ╚╔╩╦╠═╬¤" + // 0xC0–0xCF
  "ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀" + // 0xD0–0xDF
  "ÓßÔÒõÕµþÞÚÛÙýÝ¯´" + // 0xE0–0xEF
  "­±‗¾¶§÷¸°¨·¹³²■ "; // 0xF0–0xFF

const CP850_BY_CHAR: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (let i = 0; i < CP850_HIGH.length; i++) {
    m.set(CP850_HIGH[i], 0x80 + i);
  }
  return m;
})();

/**
 * Reemplazos para caracteres que no existen en CP850 pero aparecen todo
 * el tiempo en texto pegado desde un celular o un Word.
 */
const TRANSLITERATIONS: Record<string, string> = {
  "‘": "'", // ‘
  "’": "'", // ’
  "‚": "'", // ‚
  "“": '"', // “
  "”": '"', // ”
  "„": '"', // „
  "–": "-", // –
  "—": "-", // —
  "−": "-", // −
  "…": "...", // …
  "€": "EUR", // €
  "•": "*", // •
  "™": "TM", // ™
  "№": "No.", // №
  " ": " ", // NBSP → espacio normal (que salga como 0x20, no 0xFF)
  " ": " ", // espacio fino
  " ": " ", // NBSP fino
  "\t": " ",
};

/** Emoji / pictogramas / selectores de variación / formato: se descartan. */
const DROPPED = /[\p{Extended_Pictographic}‍︎️\p{Cf}]/u;

/** Carácter de último recurso cuando no hay forma de representar algo. */
const FALLBACK = "?";

/**
 * Pasa un string arbitrario a algo 100% representable en CP850.
 * Es puro y determinista — es lo que se testea.
 */
export function toCp850Text(input: string): string {
  let out = "";
  // Normalizar a NFC primero: un "ñ" tecleado como n + tilde combinante
  // (pasa al pegar desde macOS/iOS) es un solo carácter en CP850 después
  // de componer, y si no se compone se pierde la tilde.
  for (const ch of input.normalize("NFC")) {
    const direct = TRANSLITERATIONS[ch];
    if (direct !== undefined) {
      out += direct;
      continue;
    }
    const code = ch.codePointAt(0)!;
    // ASCII imprimible + salto de línea pasan derecho.
    if (ch === "\n" || (code >= 0x20 && code <= 0x7e)) {
      out += ch;
      continue;
    }
    if (CP850_BY_CHAR.has(ch)) {
      out += ch;
      continue;
    }
    if (DROPPED.test(ch)) continue;
    // Último intento: quitarle los diacríticos y ver si la base entra.
    const stripped = ch.normalize("NFD").replace(/\p{M}/gu, "");
    if (stripped && stripped !== ch) {
      out += toCp850Text(stripped);
      continue;
    }
    if (code < 0x20) continue; // control chars sueltos: fuera
    out += FALLBACK;
  }
  return out;
}

/** Bytes CP850 de un string arbitrario, transliterando lo que no exista. */
export function encodeCp850(input: string): Buffer {
  const text = toCp850Text(input);
  const bytes = Buffer.alloc(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // ASCII gana siempre: 0xFF en CP850 es NBSP, y sin este corte un
    // espacio normal se codificaría como 0xFF.
    bytes[i] = code <= 0x7e ? code : (CP850_BY_CHAR.get(text[i]) ?? 0x3f);
  }
  return bytes;
}
