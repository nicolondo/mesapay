/**
 * Piezas del formato COMPACTO que comparten la factura (`invoice.ts`) y la
 * precuenta (`prebill.ts`).
 *
 * El dueño lo pidió textual: "quiero que el formato optimice espacio
 * vertical lo que más se pueda". Una cuenta de 40 platos era un metro de
 * papel, en buena parte aire: cada modificador en su renglón, el nombre
 * del plato partido porque el precio le reservaba la columna en todos los
 * renglones, NIT/dirección/ciudad/teléfono uno debajo del otro, y el
 * interlineado de fábrica. Lo que se compacta es el ESPACIO, nunca el
 * contenido: todo lo que la factura electrónica tiene que decir lo sigue
 * diciendo.
 *
 * Las reglas, en un solo lugar para que los dos papeles se lean igual:
 *
 *   · ítem: "2x Nombre ....... $ precio" con el precio en el primer
 *     renglón y el nombre usando todo el ancho (`itemRow`);
 *   · modificadores y nota JUNTOS en un renglón en fuente B (la chica,
 *     1/3 más de columnas), separados por " · " y con sangría;
 *   · filas de totales de a una, y la FUERTE (TOTAL, pendiente) en
 *     negrita a doble ALTO con el ancho normal (`totalRowChunks`);
 *   · textos legales en fuente B;
 *   · un margen superior después del reset (`compactStart`).
 *
 * Y dos reglas de TAMAÑO, para cualquier renglón agrandado (`GS !`):
 *
 *   · se rellena contra las columnas EFECTIVAS de su tamaño: a doble ancho
 *     entra la mitad (`colsForSize`, `padRowForSize`);
 *   · se imprime con un interlineado ≥ el alto de su letra, y después se
 *     vuelve al compacto (`withLineSpacingFor`).
 */

import { itemDetailText } from "@/lib/invoice";
import {
  COMPACT_LINE_SPACING_DOTS,
  FONT_A_HEIGHT_DOTS,
  INIT,
  NORMAL_SIZE,
  TOP_MARGIN_DOTS,
  bold,
  feedDots,
  itemRow,
  line,
  lineSpacing,
  padRow,
  selectCodePage,
  selectFont,
  textSize,
  wrap,
} from "./commands";

/** Sangría de los renglones colgados de un ítem (fuente A). */
export const INDENT = "   ";

/**
 * Sangría del renglón de detalle (fuente B). La B mide 9 puntos de ancho
 * contra 12 de la A: 4 caracteres B ocupan lo mismo que los 3 de `INDENT`,
 * así el detalle queda alineado debajo del nombre del plato.
 */
export const SMALL_INDENT = "    ";

/** Separador del renglón de detalle: "Término: 1/2 · Guarniciones: Papas". */
export const DETAIL_SEPARATOR = " · ";

/**
 * Modificadores + nota del ítem en UN solo texto (`itemDetailText`, el
 * mismo formato que la vista HTML), con `extra` adelante (el unitario de
 * la precuenta). Vacío si no hay nada que decir.
 */
export function itemDetail(
  modifiers: readonly string[] | undefined,
  notes: string | null | undefined,
  extra: readonly string[] = [],
): string {
  return [...extra, itemDetailText({ modifiers, notes })]
    .filter((p) => p.length > 0)
    .join(DETAIL_SEPARATOR);
}

/**
 * Un ítem al papel: el renglón (o renglones) del plato en fuente A y, si
 * hay detalle, UN renglón en fuente B (más, sólo si no entra en uno).
 */
export function itemChunks(
  item: { qty: number; name: string; amount: string; detail: string },
  cols: number,
  smallCols: number,
): Buffer[] {
  const out: Buffer[] = [];
  for (const l of itemRow(`${item.qty}x ${item.name}`, item.amount, cols, {
    cont: INDENT,
  })) {
    out.push(line(l));
  }
  if (item.detail) {
    out.push(selectFont("B"));
    for (const l of wrap(item.detail, smallCols, {
      first: SMALL_INDENT,
      cont: SMALL_INDENT,
    })) {
      out.push(line(l));
    }
    out.push(selectFont("A"));
  }
  return out;
}

/**
 * Apertura de la tirilla compacta: reset, code page CP850, interlineado
 * compacto y el margen superior (`TOP_MARGIN_DOTS`), para que el primer
 * renglón —el nombre del comercio— no quede pegado al borde del corte.
 */
export function compactStart(): Buffer[] {
  return [
    INIT,
    selectCodePage(),
    lineSpacing(COMPACT_LINE_SPACING_DOTS),
    feedDots(TOP_MARGIN_DOTS),
  ];
}

/** Multiplicadores de `GS !` de un renglón agrandado. */
export type TextSize = { width: number; height: number };

/**
 * El TOTAL (y lo pendiente de la precuenta): doble ALTO, ancho normal.
 *
 * Antes iba a doble ANCHO relleno a media línea (24 columnas en 80 mm):
 * un renglón que llena el papel hasta el último punto, y en la térmica
 * de Son y Melona "TOTAL" y "$ 175.560" salieron encimados con las filas
 * de al lado (FESM6723). A doble alto el renglón mide lo mismo de ancho
 * que todos los demás —48/32 columnas, las que se sabe que entran—, el
 * monto se lee de lejos igual, nunca se parte y un total largo en 58 mm
 * no tiene que bajar a tamaño normal. Cuesta 24 puntos de alto (~3 mm)
 * por fila fuerte, que es lo que se paga por no desbordar.
 */
export const TOTAL_SIZE: TextSize = { width: 1, height: 2 };

/** Columnas EFECTIVAS a ese tamaño: a doble ancho entra la mitad. */
export function colsForSize(cols: number, size: TextSize): number {
  return Math.max(1, Math.floor(cols / Math.max(1, size.width)));
}

/** `padRow` contra las columnas efectivas del tamaño (`colsForSize`). */
export function padRowForSize(
  left: string,
  right: string,
  cols: number,
  size: TextSize,
): string[] {
  return padRow(left, right, colsForSize(cols, size));
}

/**
 * Envuelve renglones YA armados (con su LF) en un tamaño agrandado: si la
 * letra es más alta que el interlineado compacto, lo sube al alto de la
 * letra mientras duran (`ESC 3 48` a doble alto) y lo devuelve al
 * compacto después; el tamaño vuelve siempre a 1×1. Así ningún renglón
 * se imprime con un interlineado menor que su letra, que es lo que
 * algunas térmicas recortan (ver `lineSpacing`).
 *
 * Supone la fuente A (la única que se agranda) y que afuera rige el
 * interlineado compacto, que es el caso de la factura y la precuenta.
 */
export function withLineSpacingFor(size: TextSize, body: Buffer[]): Buffer[] {
  const charHeight = FONT_A_HEIGHT_DOTS * Math.max(1, size.height);
  const tall = charHeight > COMPACT_LINE_SPACING_DOTS;
  return [
    ...(tall ? [lineSpacing(charHeight)] : []),
    textSize(size.width, size.height),
    ...body,
    NORMAL_SIZE,
    ...(tall ? [lineSpacing(COMPACT_LINE_SPACING_DOTS)] : []),
  ];
}

/**
 * Una fila de totales. La fuerte (TOTAL, "pendiente por pagar") va en
 * negrita a `TOTAL_SIZE` —doble alto, ancho normal— rellena contra las
 * columnas efectivas de ese tamaño y con el interlineado de su letra.
 */
export function totalRowChunks(
  row: { label: string; amount: string; strong?: boolean },
  cols: number,
): Buffer[] {
  if (!row.strong) return padRow(row.label, row.amount, cols).map(line);
  return [
    bold(true),
    ...withLineSpacingFor(
      TOTAL_SIZE,
      padRowForSize(row.label, row.amount, cols, TOTAL_SIZE).map(line),
    ),
    bold(false),
  ];
}
