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
 *   · filas de totales de a una, y la FUERTE (TOTAL, pendiente) a doble
 *     ANCHO —que no gasta alto— cuando entra; si no, negrita normal;
 *   · textos legales en fuente B.
 */

import { itemDetailText } from "@/lib/invoice";
import {
  NORMAL_SIZE,
  bold,
  itemRow,
  line,
  padRow,
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
 * Una fila de totales. La fuerte (TOTAL, "pendiente por pagar") va en
 * negrita y a doble ANCHO si entra en media línea: se destaca sin gastar
 * el renglón extra del doble alto. Si no entra (un total largo en 58mm)
 * va en negrita al tamaño normal, que nunca parte el monto.
 */
export function totalRowChunks(
  row: { label: string; amount: string; strong?: boolean },
  cols: number,
): Buffer[] {
  if (!row.strong) return padRow(row.label, row.amount, cols).map(line);
  const half = Math.floor(cols / 2);
  if (row.label.length + 1 + row.amount.length <= half) {
    return [
      bold(true),
      textSize(2, 1),
      ...padRow(row.label, row.amount, half).map(line),
      NORMAL_SIZE,
      bold(false),
    ];
  }
  return [bold(true), ...padRow(row.label, row.amount, cols).map(line), bold(false)];
}
