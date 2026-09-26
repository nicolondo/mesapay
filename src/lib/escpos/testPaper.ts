/**
 * Utilidades SÓLO para tests: leen los bytes ESC/POS "como el papel".
 *
 * `readPaper` saca los comandos conocidos, pasa el texto por CP850 y
 * además MIDE: cuántos renglones salen (cada LF es uno) y un alto
 * estimado en puntos, con el interlineado vigente (`ESC 3 n` / `ESC 2`),
 * la fuente (A 24 pt de alto, B 17) y el multiplicador de alto (`GS !`).
 * El QR (`GS ( k`) se salta: es una imagen, no renglones.
 *
 * Un comando que este lector no conoce revienta, igual que el `readable`
 * de cada test: así no se cuela un comando nuevo sin que alguien lo mire.
 */

import { CP850_HIGH } from "./codepage";

/** `ESC 2`: el interlineado por defecto de las térmicas Epson y afines. */
const DEFAULT_SPACING = 30;
const FONT_HEIGHT = { A: 24, B: 17 } as const;

/** Un renglón impreso con la letra con la que salió. */
export type PaperRow = {
  text: string;
  font: "A" | "B";
  /** Multiplicadores de `GS !` vigentes al imprimir el renglón. */
  widthMul: number;
  heightMul: number;
};

export type Paper = {
  /** El texto tal como se lee en el papel, un renglón por línea. */
  text: string;
  /** Los mismos renglones, con su fuente y tamaño (para medir anchos). */
  rows: PaperRow[];
  /**
   * Renglones impresos (cada LF), sin contar el avance antes del corte
   * (`ESC d n`), que es el mismo en todas las versiones.
   */
  lines: number;
  /** Alto estimado de los renglones, en puntos. */
  heightDots: number;
};

export function readPaper(b: Buffer): Paper {
  let text = "";
  let current = "";
  const rows: PaperRow[] = [];
  let widthMul = 1;
  let lines = 0;
  let heightDots = 0;
  let spacing = DEFAULT_SPACING;
  let font: "A" | "B" = "A";
  let heightMul = 1;
  let i = 0;
  while (i < b.length) {
    const byte = b[i];
    if (byte === 0x1b) {
      const op = b[i + 1];
      if (op === 0x40) {
        spacing = DEFAULT_SPACING;
        font = "A";
        heightMul = 1;
        widthMul = 1;
        i += 2;
        continue;
      }
      if (op === 0x32) {
        spacing = DEFAULT_SPACING;
        i += 2;
        continue;
      }
      if (op === 0x33) {
        spacing = b[i + 2];
        i += 3;
        continue;
      }
      if (op === 0x4d) {
        font = b[i + 2] === 1 ? "B" : "A";
        i += 3;
        continue;
      }
      // ESC d n: avance antes del corte — no es contenido.
      if (op === 0x74 || op === 0x61 || op === 0x45 || op === 0x64) {
        i += 3;
        continue;
      }
      throw new Error(`comando ESC desconocido: 0x${op.toString(16)}`);
    }
    if (byte === 0x1d) {
      const op = b[i + 1];
      if (op === 0x21) {
        heightMul = (b[i + 2] & 0x0f) + 1;
        widthMul = ((b[i + 2] >> 4) & 0x0f) + 1;
        i += 3;
        continue;
      }
      if (op === 0x56) {
        i += 4;
        continue;
      }
      // GS ( k: pL pH dicen cuánto sigue (cn fn + datos).
      if (op === 0x28) {
        const len = b[i + 3] | (b[i + 4] << 8);
        i += 5 + len;
        continue;
      }
      throw new Error(`comando GS desconocido: 0x${op.toString(16)}`);
    }
    if (byte === 0x0a) {
      text += "\n";
      rows.push({ text: current, font, widthMul, heightMul });
      current = "";
      lines += 1;
      heightDots += Math.max(spacing, FONT_HEIGHT[font] * heightMul);
      i += 1;
      continue;
    }
    const ch = byte <= 0x7e ? String.fromCharCode(byte) : CP850_HIGH[byte - 0x80];
    text += ch;
    current += ch;
    i += 1;
  }
  return { text, rows, lines, heightDots };
}

/**
 * Cuántos caracteres entran en un renglón de ese papel con esa letra:
 * fuente A 48/32, fuente B 64/42, divididos por el doble ancho.
 */
export function rowCapacity(row: PaperRow, paperWidthMm: number): number {
  const a = paperWidthMm >= 80 ? 48 : 32;
  const cols = row.font === "B" ? Math.floor((a * 4) / 3) : a;
  return Math.floor(cols / row.widthMul);
}
