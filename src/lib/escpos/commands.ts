/**
 * Comandos ESC/POS crudos.
 *
 * Es el juego mínimo que necesita una comanda de cocina: inicializar,
 * elegir code page, alinear, negrita, tamaño de letra, avanzar papel y
 * cortar. Cada función devuelve el Buffer del comando — nada de estado
 * global — para que armar un ticket sea concatenar.
 *
 * Referencia: Epson ESC/POS Command Reference. Los comandos elegidos son
 * los del subconjunto "estándar" que implementan también las térmicas
 * genéricas (Xprinter, Rongta, EPOS…) que es lo que hay en las cocinas.
 */

import { CODE_PAGE_CP850, encodeCp850 } from "./codepage";

const ESC = 0x1b;
const GS = 0x1d;

/** Salto de línea. */
export const LF = Buffer.from([0x0a]);

/** `ESC @` — reset. Borra negrita/tamaño/alineación de lo que quedó antes. */
export const INIT = Buffer.from([ESC, 0x40]);

/** `ESC t n` — selecciona la tabla de caracteres. */
export function selectCodePage(n: number = CODE_PAGE_CP850): Buffer {
  return Buffer.from([ESC, 0x74, n]);
}

export type Align = "left" | "center" | "right";

/** `ESC a n` — justificación. */
export function align(a: Align): Buffer {
  const n = a === "center" ? 1 : a === "right" ? 2 : 0;
  return Buffer.from([ESC, 0x61, n]);
}

/** `ESC E n` — negrita (enfatizado). */
export function bold(on: boolean): Buffer {
  return Buffer.from([ESC, 0x45, on ? 1 : 0]);
}

/**
 * `GS ! n` — tamaño de carácter. Los multiplicadores van de 1 a 8; se
 * usa 1 y 2 nada más porque a 3× ya no entran ni cinco caracteres en
 * 58mm. OJO: al duplicar el ancho, las columnas disponibles se parten a
 * la mitad — eso lo maneja quien arma el ticket, no este comando.
 */
export function textSize(widthMul: number, heightMul: number): Buffer {
  const w = Math.min(8, Math.max(1, Math.trunc(widthMul))) - 1;
  const h = Math.min(8, Math.max(1, Math.trunc(heightMul))) - 1;
  return Buffer.from([GS, 0x21, (w << 4) | h]);
}

/** Vuelve al tamaño normal (1×1). */
export const NORMAL_SIZE = textSize(1, 1);

/** `ESC d n` — avanza n líneas. */
export function feed(lines: number): Buffer {
  const n = Math.min(255, Math.max(0, Math.trunc(lines)));
  return Buffer.from([ESC, 0x64, n]);
}

/**
 * `GS V 66 n` — corte parcial después de avanzar n×(altura de línea).
 * Se usa el parcial y no el total porque el parcial deja un puntito de
 * papel unido: la comanda no se cae al piso antes de que el cocinero la
 * arranque. Las térmicas sin cortador simplemente ignoran el comando.
 */
export function cut(feedUnits = 4): Buffer {
  const n = Math.min(255, Math.max(0, Math.trunc(feedUnits)));
  return Buffer.from([GS, 0x56, 0x42, n]);
}

/** Texto ya codificado en CP850 + salto de línea. */
export function line(text: string): Buffer {
  return Buffer.concat([encodeCp850(text), LF]);
}

/**
 * Cuántas columnas de fuente A (12×24 px) entran según el ancho de papel.
 * 80mm → 48, 58mm → 32. Cualquier otro ancho se interpola con la misma
 * densidad de la de 80mm (≈0.6 col/mm sobre el área imprimible).
 */
export function columnsForWidth(paperWidthMm: number): number {
  if (paperWidthMm >= 80) return 48;
  if (paperWidthMm <= 58) return 32;
  return Math.max(24, Math.round((paperWidthMm - 58) * (16 / 22)) + 32);
}

/**
 * Corta un texto en líneas de a lo sumo `width` columnas, partiendo por
 * espacios. Una palabra más larga que la línea (un nombre de plato sin
 * espacios, una URL) se parte a lo bruto en vez de desbordar: la térmica
 * no hace wrap, trunca — y perder el final de "Hamburguesa..." es peor
 * que partirla en dos renglones.
 *
 * `first` es la sangría del primer renglón y `cont` la de los renglones
 * colgados. Ambas CUENTAN contra el ancho: por eso van acá y no
 * concatenadas por quien llama — un `"   " + texto` se perdería, porque
 * el corte por espacios se come el espacio inicial.
 */
export function wrap(
  text: string,
  width: number,
  opts: { first?: string; cont?: string } = {},
): string[] {
  const w = Math.max(1, width);
  // Una sangría tan ancha como la línea dejaría el corte sin avanzar.
  const fit = (s: string) => (s.length < w ? s : "");
  const first = fit(opts.first ?? "");
  const cont = fit(opts.cont ?? opts.first ?? "");
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let current = "";
    let isFirst = true;
    const prefix = () => (isFirst ? first : cont);
    for (const word of words) {
      const candidate =
        current === "" ? prefix() + word : current + " " + word;
      if (candidate.length <= w) {
        current = candidate;
        continue;
      }
      if (current !== "") {
        out.push(current);
        isFirst = false;
        current = "";
      }
      // La palabra sola tampoco entra en un renglón: partirla a lo bruto.
      let rest = prefix() + word;
      while (rest.length > w) {
        out.push(rest.slice(0, w));
        isFirst = false;
        rest = cont + rest.slice(w);
      }
      current = rest;
    }
    if (current !== "") out.push(current);
  }
  return out;
}

/** Línea de guiones del ancho del papel — el separador de la comanda. */
export function separator(columns: number): Buffer {
  return line("-".repeat(Math.max(1, columns)));
}
