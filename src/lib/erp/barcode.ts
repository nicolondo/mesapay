// Normalización del código de barras del insumo.
//
// El lector de código de barras típico del mercado NO es una cámara: es un
// lector "tipo teclado" (HID) que teclea el código muy rápido y manda un
// Enter. Eso significa que lo que llega al input puede traer basura de
// teclado alrededor: el propio Enter/retorno de carro, el tabulador que
// algunos modelos mandan como sufijo, o espacios que el operador metió sin
// querer al digitar el código a mano. Esa basura es INVISIBLE en pantalla
// pero rompe la comparación exacta contra lo guardado — por eso se limpia
// SIEMPRE en el mismo punto: al guardar y al buscar.
//
// Lo que NO se toca es la CAJA (mayúsculas/minúsculas). Pasar a mayúsculas
// "por si acaso" corrompería un Code128 con minúsculas: el lector mandaría
// "ab12" y en la base habría "AB12", que ya no matchea nunca. Guardando el
// código tal cual se escaneó, la comparación contra la ráfaga del lector es
// siempre fiel, y "ab12" vs "AB12" quedan como dos códigos distintos — que
// es exactamente lo que son en el estándar.

/** Tope de longitud: el más largo de uso real (GS1-128) no pasa de 48. */
export const BARCODE_MAX_LENGTH = 64;

/**
 * Limpia lo escaneado/digitado y devuelve `null` cuando no queda nada —
 * "sin código de barras" es un estado válido del insumo, no un error.
 *
 * Se quitan los espacios (incluidos tabs y saltos de línea) y todo lo que
 * no sea ASCII imprimible: los simbolismos de código de barras solo emiten
 * ASCII, así que cualquier otra cosa es ruido del lector, no dato.
 */
export function normalizeBarcode(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/\s/g, "").replace(/[^!-~]/g, "");
  return cleaned === "" ? null : cleaned;
}
