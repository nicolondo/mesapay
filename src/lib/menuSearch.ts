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

/*
 * ---------------------------------------------------------------------
 * Búsqueda global de la carta del comensal
 * ---------------------------------------------------------------------
 *
 * Con texto en el buscador, los resultados salen de TODA la carta:
 * todas las pestañas (Carta, Vinos, Bebidas…) y todas las categorías,
 * sin importar en cuál estaba parado el comensal. Antes el componente
 * armaba las "cubetas" sólo con las categorías de la pestaña activa, así
 * que buscar "malbec" parado en "Carta" no devolvía nada aunque el vino
 * existiera en "Vinos": el ítem caía en una categoría sin cubeta y se
 * descartaba en silencio.
 *
 * La función es pura y no recibe categoría ni pestaña activa a propósito:
 * no hay forma de que un filtro de presentación se cuele en la búsqueda.
 * Lo único que "filtra" es lo que ya venía filtrado del server
 * (`available: true`): un plato agotado no está en `allItems` y por eso
 * no aparece; eso no cambia acá.
 */

export type SearchableCategory = {
  id: string;
  label: string;
  menuId: string;
  parentId: string | null;
};
export type SearchableMenu = { id: string; label: string };
export type SearchableItem = {
  categoryId: string;
  name: string;
  description?: string | null;
};

/** Un grupo de resultados: la categoría, de dónde viene y sus platos. */
export type MenuSearchGroup<
  I extends SearchableItem,
  C extends SearchableCategory,
> = {
  category: C;
  /** Categoría padre (el grupo: "Tintos" para "Malbec"), si es subcategoría. */
  parent: C | null;
  /** Pestaña de carta a la que pertenece; null si no se pasaron pestañas. */
  menu: SearchableMenu | null;
  items: I[];
};

/**
 * Orden de la carta: pestañas en su orden, dentro de cada una las
 * categorías de nivel superior seguidas de sus subcategorías, y al final
 * cualquier categoría que no cuelgue de ninguna pestaña conocida (no
 * debería pasar, pero si pasa se muestra en vez de perderse).
 */
function categoriesInMenuOrder<C extends SearchableCategory>(
  categories: C[],
  menus: SearchableMenu[],
): C[] {
  const ordered: C[] = [];
  const seen = new Set<string>();
  const pushTree = (tops: C[]) => {
    for (const top of tops) {
      if (seen.has(top.id)) continue;
      ordered.push(top);
      seen.add(top.id);
      for (const child of categories) {
        if (child.parentId === top.id && !seen.has(child.id)) {
          ordered.push(child);
          seen.add(child.id);
        }
      }
    }
  };
  for (const m of menus) {
    pushTree(categories.filter((c) => c.menuId === m.id && !c.parentId));
  }
  pushTree(categories.filter((c) => !c.parentId));
  for (const c of categories) {
    if (!seen.has(c.id)) {
      ordered.push(c);
      seen.add(c.id);
    }
  }
  return ordered;
}

/**
 * Busca `query` en toda la carta y devuelve los resultados agrupados por
 * categoría, en el orden de la carta (no hay puntaje de relevancia: la
 * coincidencia es todo-o-nada por palabras, ver `matchesQuery`).
 *
 * - Se busca en nombre y descripción, con TODAS las palabras.
 * - Consulta vacía o sin letras/números ⇒ `[]` (no hay búsqueda activa).
 * - Un ítem cuya categoría no está en `categories` se omite: no habría
 *   dónde mostrarlo. Con el FK de Prisma no debería ocurrir.
 */
export function searchMenuItems<
  I extends SearchableItem,
  C extends SearchableCategory,
>(
  allItems: I[],
  query: string,
  ctx: { categories: C[]; menus?: SearchableMenu[] },
): MenuSearchGroup<I, C>[] {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return [];
  const menus = ctx.menus ?? [];
  const byCat = new Map<string, I[]>();
  for (const it of allItems) {
    if (!matchesQuery(`${it.name} ${it.description ?? ""}`, tokens)) continue;
    const bucket = byCat.get(it.categoryId);
    if (bucket) bucket.push(it);
    else byCat.set(it.categoryId, [it]);
  }
  if (byCat.size === 0) return [];
  const catById = new Map(ctx.categories.map((c) => [c.id, c] as const));
  const menuById = new Map(menus.map((m) => [m.id, m] as const));
  const groups: MenuSearchGroup<I, C>[] = [];
  for (const category of categoriesInMenuOrder(ctx.categories, menus)) {
    const items = byCat.get(category.id);
    if (!items || items.length === 0) continue;
    groups.push({
      category,
      parent: category.parentId
        ? (catById.get(category.parentId) ?? null)
        : null,
      menu: menuById.get(category.menuId) ?? null,
      items,
    });
  }
  return groups;
}
