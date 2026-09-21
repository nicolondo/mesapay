/**
 * Etiquetas compartidas entre rutas API (CSV) y páginas: el origen del
 * asiento se traduce con las claves `opErp.jSource_<source>` que ya usa
 * el Diario; si llega un origen sin clave (p. ej. uno nuevo de otro PR),
 * se muestra el identificador tal cual en vez de romper.
 */
type TranslatorLike = { (key: string): string; has(key: string): boolean };

export function makeSourceLabel(tErp: TranslatorLike): (source: string) => string {
  return (source) => {
    const key = `jSource_${source}`;
    return tErp.has(key) ? tErp(key) : source;
  };
}
