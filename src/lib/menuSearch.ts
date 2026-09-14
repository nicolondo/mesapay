/**
 * Búsqueda de platos — la misma en la carta del comensal y en el editor
 * del operador.
 *
 * Vivía duplicada: el comensal tenía una normalización fonética buena y
 * el editor una versión pobre (sólo minúsculas y acentos) con un
 * comentario que decía ser "equivalente". No lo era. Acá queda una sola.
 *
 * Dos piezas:
 *
 *  1. `fuzzyNormalize` — aplana el texto para que las variantes de
 *     escritura no importen (ver abajo).
 *  2. `matchesQuery` — exige que estén TODAS las palabras buscadas, en
 *     cualquier orden y sin necesidad de que sean contiguas. Antes se
 *     comparaba la consulta entera como una sola cadena, así que
 *     "solomito res" NO encontraba "Solomito de res": el "de" del medio
 *     rompía la coincidencia. Buscar dos palabras sueltas y que el
 *     buscador falle es exactamente lo que nadie espera.
 */

/**
 * Aplana un texto para buscar sin que importe cómo se escribió:
 *  - Acentos y ñ: "café" encuentra "Cafe", "piña" encuentra "pina".
 *  - Puntuación: "Sangría, espumosa" matchea "sangria espumosa".
 *  - Confusiones ortográficas comunes en español:
 *      pescado ↔ pezcado    (c suave / z → s)
 *      cafe    ↔ kafe       (c fuerte / qu → k)
 *      vaso    ↔ baso       (b / v → b)
 *      ola     ↔ hola       (h muda)
 *      yegua   ↔ llegua     (ll / y → i)
 *
 * La transformación corre sobre la consulta Y sobre el texto del plato,
 * así que cualquier colisión es simétrica: escribir "vaka" encuentra
 * "vaca" porque las dos terminan en "baka". Para una carta colombiana
 * el ruido que agrega es preferible a rechazar un error de tipeo.
 */
export function fuzzyNormalize(s: string): string {
  let out = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // acentos combinantes
  out = out
    .replace(/ñ/g, "n")
    .replace(/[^a-z0-9 ]+/g, " "); // puntuación → espacio
  // El orden importa: los dígrafos primero, si no se destrozan.
  out = out
    .replace(/qu/g, "k") // qu siempre suena k: quilo → kilo
    .replace(/ll/g, "i") // ll suena i/y: llave → iave
    // c suave (antes de e/i/y) suena s; c fuerte suena k. Separar la
    // regla mantiene "cafe" → "kafe" y "cesta" → "sesta" correctos.
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/[bv]/g, "b")
    .replace(/h/g, "") // h muda: huevo → uevo, hola → ola
    .replace(/y/g, "i")
    .replace(/\s+/g, " ")
    .trim();
  return out;
}

/**
 * Palabras de la consulta, ya normalizadas. Vacío ⇒ no hay búsqueda
 * activa y no hay que filtrar nada.
 *
 * Se calcula una vez por consulta y se reusa para todos los platos: con
 * una carta de varios cientos de ítems, normalizar la consulta dentro
 * del bucle es trabajo repetido por nada.
 */
export function searchTokens(query: string): string[] {
  const normalized = fuzzyNormalize(query);
  return normalized ? normalized.split(" ") : [];
}

/**
 * ¿El texto del plato contiene TODAS las palabras buscadas?
 *
 * Cada palabra se busca como subcadena y no como palabra completa, para
 * no perder lo que ya funcionaba: "burguesa" tiene que seguir
 * encontrando "Hamburguesa". El costo es que una palabra muy corta
 * pesca de más ("res" aparece dentro de "fresa"), que es el mismo
 * comportamiento que había antes y se corrige solo apenas se escribe
 * una segunda palabra.
 */
export function matchesQuery(haystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = fuzzyNormalize(haystack);
  return tokens.every((t) => hay.includes(t));
}
