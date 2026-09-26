/**
 * Shared menu search: prefer complete words, then autocomplete names.
 * Descriptions match complete words only, so agua does not match aguacate.
 * Accent/Spanish spelling normalization remains shared with legacy callers.
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
 * Legacy substring matcher retained for compatibility and regression fixtures.
 * @deprecated Use rankMenuItems/searchMenuItems for menu results: this primitive
 * cannot distinguish a product name from an incidental description substring.
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

type RankedItem<I> = { item: I; score: number };

function rankedMatches<I extends SearchableItem>(items: I[], query: string): RankedItem<I>[] {
  const tokens = searchTokens(query);
  if (!tokens.length) return items.map((item) => ({ item, score: 0 }));
  const shortQuery = tokens.every((token) => token.length < 3);
  const prepared = items.map((item) => ({
    item,
    name: searchTokens(item.name),
    description: new Set(searchTokens(item.description ?? "")),
  }));
  const collect = (partial: boolean): RankedItem<I>[] => prepared.flatMap(({ item, name, description }) => {
    let score = 0;
    for (const token of tokens) {
      const inName = name.some((word) => word === token || (partial &&
        (word.startsWith(token) || (token.length >= 5 && word.includes(token)))));
      if (inName) score++;
      else if (shortQuery || !description.has(token)) return [];
    }
    return [{ item, score }];
  });
  // Whole-word results suppress incidental partial names. For one/two
  // letters keep autocomplete rather than selecting a preposition alone.
  const exact = shortQuery ? [] : collect(false);
  return (exact.length ? exact : collect(true)).sort((a, b) => b.score - a.score);
}

/** Rank names ahead of description-only matches without changing the input. */
export function rankMenuItems<I extends SearchableItem>(items: I[], query: string): I[] {
  return rankedMatches(items, query).map(({ item }) => item);
}

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
 * categoría. Nombre antes que descripción; a igual relevancia se conserva
 * el orden de la carta y de sus platos.
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
  const catById = new Map(ctx.categories.map((c) => [c.id, c] as const));
  // An invisible/orphaned exact match must not suppress visible prefixes.
  const ranked = rankedMatches(allItems.filter((item) => catById.has(item.categoryId)), query);
  const byCat = new Map<string, I[]>();
  const relevance = new Map<string, number>();
  for (const { item, score } of ranked) {
    const bucket = byCat.get(item.categoryId);
    if (bucket) bucket.push(item);
    else {
      byCat.set(item.categoryId, [item]);
      relevance.set(item.categoryId, score);
    }
  }
  if (byCat.size === 0) return [];
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
  return groups.sort((a, b) => relevance.get(b.category.id)! - relevance.get(a.category.id)!);
}
