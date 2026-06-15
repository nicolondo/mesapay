/**
 * Cluvi menu importer.
 *
 * Cluvi (cluvi.co / cluvi.com) is a Colombian digital-menu / ordering
 * platform used by a long tail of restaurants (son-y-melona, etc.). The
 * storefront at `https://<tienda>.cluvi.co/newmenu/<storeId>/<type>/<subtype>`
 * is a Vite SPA: the HTML is an empty shell and the menu loads from a
 * public JSON API. We hit that API directly — far more reliable than
 * scraping the hydrated DOM or running AI over the shell.
 *
 * API (discovered from the bundle's `getMenuCache`):
 *
 *   https://cached.cluvi.com/v1/menu/{storeId}/{type}/{subtype}.json?lang=es
 *
 * where `{type}/{subtype}` come from the storefront path (on_table/basic
 * for the dine-in carta — the right one for a MESAPAY restaurant).
 *
 * Response shape (relevant chunks):
 *
 *   {
 *     customer: { decimals, currency, ... },
 *     menu: {
 *       categories: [                      // main categories
 *         { id, label, order, subcategories: [
 *             { id, label, order, product_ids: [<productId>, ...] }  // leaf
 *         ] }
 *       ],
 *       products: [                        // flat pool, keyed by id
 *         { id, label, description(HTML), price:"119000.0", image{...},
 *           out_of_stock, redirect_to, ... }
 *       ],
 *     }
 *   }
 *
 * Nesting is depth-1 (main → subcategory leaf). Products carry no
 * category field — the leaf subcategory's `product_ids` is the linkage.
 * Prices are pesos strings ("119000.0" = $119.000); descriptions are HTML.
 */

import type { MenuExtraction } from "@/lib/anthropic";
import { localizeImagesWithFallback } from "@/lib/menuImportImages";
import { checkUrlSafe } from "@/lib/ssrf";

type CluviImage = {
  blog?: string | null;
  thumb?: string | null;
  w_576?: string | null;
  w_768?: string | null;
  w_992?: string | null;
  w_1200?: string | null;
} | null;

type CluviProduct = {
  id: string;
  label?: string | null;
  description?: string | null;
  price?: string | number | null;
  price_full?: string | number | null;
  image?: CluviImage;
  out_of_stock?: boolean | null;
  redirect_to?: string | null;
};

type CluviCategory = {
  id?: number | string;
  label?: string | null;
  order?: number | null;
  product_ids?: string[] | null;
  subcategories?: CluviCategory[] | null;
};

type CluviMenuResponse = {
  customer?: { decimals?: number | null; currency?: string | null } | null;
  menu?: {
    categories?: CluviCategory[] | null;
    products?: CluviProduct[] | null;
  } | null;
};

const FETCH_TIMEOUT_MS = 15_000;
// Fixed, public hosts. Hardcoded (never derived from user input) so there's
// no SSRF surface on the host:
//  - cached.cluvi.com / services.cluvi.com sirven el JSON del menú. El SPA
//    usa el primero si `instance.menu_cached`, si no el segundo; probamos
//    ambos en orden.
//  - exp2.cluvi.com resuelve el slug/subdominio de la tienda a su id numérico
//    de supplier (lo que la app hace en su acción GetSupplier).
const MENU_HOSTS = ["https://cached.cluvi.com", "https://services.cluvi.com"];
const RESOLVE_HOST = "https://exp2.cluvi.com";

// Same promo / catch-all filter idea as the Justo + Shopify importers:
// buckets that dilute the real menu structure.
const PROMO_PATTERNS = [
  /promoci/i,
  /recomendad/i,
  /favorit/i,
  /lealtad/i,
  /^todos$/i,
  /^all$/i,
  /^home$/i,
  /points?\b/i,
];

function isPromotional(title: string): boolean {
  return PROMO_PATTERNS.some((rx) => rx.test(title));
}

function kindFromName(
  name: string,
): "starter" | "main" | "side" | "drink" | "dessert" | "other" {
  const s = name.toLowerCase();
  // Palabras cortas/ambiguas: exigen límite de palabra para no matchear
  // dentro de otra (ej. "ron" en "chicharRONes", "gin" en "imaGINar").
  if (/\b(ron|gin|vino|licor|jugo|agua|t[eé]|mezcla|copa|sidra)s?\b/i.test(s))
    return "drink";
  // Términos largos: el substring es seguro.
  if (
    /bebida|cerveza|whisky|whiskey|vodka|tequila|mezcal|ginebra|aguardiente|c[oó]ctel|coctel|cocktail|mocktail|sangr[íi]a|martini|gaseosa|aromat|limonada|smoothie|mojito|aperitiv|digestiv|infusi|caf[eé]|champ|espumante|vermut|negroni|aperol/i.test(
      s,
    )
  )
    return "drink";
  if (
    /postre|gelato|tiramisu|cassata|milhoja|helado|dulce|brownie|cheesecake|torta|flan/i.test(
      s,
    )
  )
    return "dessert";
  if (
    /entrada|aperitivo|antoj|appetiz|picar|compartir|crocant[ií]|focaccia|tapa|carpaccio|ceviche|picada/i.test(
      s,
    )
  )
    return "starter";
  if (/acompa[ñn]|adicion|side|guarnici|extra|topping|salsa/i.test(s))
    return "side";
  return "main";
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "categoria"
  );
}

/** Strip Cluvi's HTML descriptions down to plain text. */
function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const s = html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/\s+/g, " ")
    .trim()
    // El endpoint de confirmación limita la descripción a 500 chars.
    .slice(0, 500);
  return s || null;
}

/**
 * Cluvi stores prices in major currency units as strings ("119000.0" =
 * $119.000 COP). We store integer cents, so multiply by 100.
 */
function priceCentsFromValue(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const pesos = typeof value === "string" ? parseFloat(value) : value;
  if (!isFinite(pesos) || pesos <= 0) return 0;
  return Math.round(pesos * 100);
}

function pickImage(img: CluviImage): string | null {
  if (!img) return null;
  return img.w_768 ?? img.w_576 ?? img.w_992 ?? img.thumb ?? img.blog ?? img.w_1200 ?? null;
}

/** Sanea un slug derivado del host/path del usuario: solo [a-z0-9-]. */
function cleanSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 60);
}

type StoreRef = {
  // Id numérico de supplier, si la URL ya lo trae (camino /newmenu/<id>).
  storeId?: string;
  // Slugs candidatos a resolver (subdominio y/o primer segmento del path),
  // en orden de prioridad. Solo se usan si no hay storeId.
  slugs: string[];
  type: string;
  subtype: string;
};

/**
 * Parse the storefront URL into the API coordinates. Two shapes:
 *  - Deep link `/newmenu/<storeId>/<type>/<subtype>` → trae el id numérico.
 *  - Raíz / subdominio (`https://oni.cluvi.co/`, `cluvi.co/oni`) → no trae id;
 *    devolvemos los slugs candidatos para resolverlos contra exp2.cluvi.com
 *    (lo mismo que hace el SPA en su acción GetSupplier).
 * Defaults keep us on the dine-in carta when the path omits type/subtype.
 */
function parseStoreRef(url: string): StoreRef | null {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return null;
  }
  if (!/(^|\.)cluvi\.(co|com)$/.test(host)) return null;

  const m = path.match(/\/newmenu\/(\d+)(?:\/([\w-]+))?(?:\/([\w-]+))?/i);
  if (m) {
    return {
      storeId: m[1],
      slugs: [],
      type: m[2] || "on_table",
      subtype: m[3] || "basic",
    };
  }

  // Subdominio: oni.cluvi.co → "oni" (descartamos www y el ápice cluvi.co).
  const slugs: string[] = [];
  const subMatch = host.match(/^(.*?)\.?cluvi\.(co|com)$/);
  const sub = cleanSlug((subMatch?.[1] ?? "").split(".")[0]);
  if (sub && sub !== "www") slugs.push(sub);
  // Primer segmento del path: cluvi.co/oni → "oni".
  let firstSeg = "";
  try {
    firstSeg = cleanSlug(
      decodeURIComponent(path.split("/").filter(Boolean)[0] ?? ""),
    );
  } catch {
    firstSeg = "";
  }
  if (firstSeg && firstSeg !== "newmenu" && !slugs.includes(firstSeg)) {
    slugs.push(firstSeg);
  }

  if (slugs.length === 0) return null;
  return { slugs, type: "on_table", subtype: "basic" };
}

async function fetchJson(url: string): Promise<unknown | null> {
  const safe = await checkUrlSafe(url);
  if (!safe.ok) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        accept: "application/json",
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resuelve un slug de tienda (subdominio o segmento del path) a su id
 * numérico de supplier. Cluvi expone el objeto supplier en dos rutas
 * (probamos ambas, igual que el bundle del SPA). El cuerpo es el supplier
 * con `id`.
 */
async function resolveSlugToStoreId(slug: string): Promise<string | null> {
  const urls = [
    `${RESOLVE_HOST}/domain/suppliers/${slug}.json`,
    `${RESOLVE_HOST}/api/suppliers/${slug}.json`,
  ];
  for (const u of urls) {
    const data = await fetchJson(u);
    if (!data || typeof data !== "object") continue;
    const obj = data as { id?: unknown; supplier?: { id?: unknown } };
    const id = obj.id ?? obj.supplier?.id;
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
    if (typeof id === "string" && /^\d+$/.test(id)) return id;
  }
  return null;
}

async function fetchMenuJson(ref: {
  storeId: string;
  type: string;
  subtype: string;
}): Promise<CluviMenuResponse | null> {
  // El SPA elige cached o services según `instance.menu_cached`; como no
  // tenemos ese flag, probamos cached primero (CDN, más rápido) y caemos a
  // services si no responde.
  for (const apiHost of MENU_HOSTS) {
    const apiUrl = `${apiHost}/v1/menu/${ref.storeId}/${ref.type}/${ref.subtype}.json?lang=es`;
    const data = (await fetchJson(apiUrl)) as CluviMenuResponse | null;
    if (data?.menu?.products?.length) return data;
  }
  return null;
}

/**
 * Detect + extract a Cluvi menu. Returns null if the URL isn't a Cluvi
 * storefront or we couldn't pull a usable menu.
 */
export async function tryImportCluvi(
  originUrl: string,
  restaurantId: string,
): Promise<{ extraction: MenuExtraction; sourceUrl: string } | null> {
  const ref = parseStoreRef(originUrl);
  if (!ref) return null;

  // Si la URL no trae id numérico (raíz/subdominio), lo resolvemos desde el
  // slug. Probamos los candidatos (subdominio, luego segmento del path).
  let storeId = ref.storeId ?? null;
  if (!storeId) {
    for (const slug of ref.slugs) {
      storeId = await resolveSlugToStoreId(slug);
      if (storeId) break;
    }
  }
  if (!storeId) return null;

  const data = await fetchMenuJson({
    storeId,
    type: ref.type,
    subtype: ref.subtype,
  });
  const categories = data?.menu?.categories;
  const products = data?.menu?.products;
  if (!Array.isArray(categories) || !Array.isArray(products)) return null;

  const byId = new Map<string, CluviProduct>();
  for (const p of products) if (p?.id) byId.set(p.id, p);

  // Lazy category map: a category slug is created the first time a real
  // item references it, so empty / promo buckets never show up.
  const categoriesBySlug = new Map<
    string,
    { slug: string; label: string; kind: ReturnType<typeof kindFromName>; sortOrder: number }
  >();
  const itemsOut: MenuExtraction["items"] = [];
  const seenProducts = new Set<string>();

  const mainCats = [...categories].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0),
  );

  for (const main of mainCats) {
    const subs = [...(main.subcategories ?? [])].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0),
    );
    // A category with multiple meaningful subcategories (e.g. "Licores" →
    // Whisky, Ron, Tequila…) keeps the subcategory split; a single wrapper
    // subcategory collapses to the main label.
    const splitBySub = subs.length > 1;

    for (const sub of subs) {
      const productIds = sub.product_ids ?? [];
      if (!productIds.length) continue;

      const rawLabel = splitBySub
        ? (sub.label?.trim() || main.label?.trim() || "")
        : (main.label?.trim() || sub.label?.trim() || "");
      const label = rawLabel || "Otros";
      if (isPromotional(label)) continue;

      const slug = slugify(label);
      if (!categoriesBySlug.has(slug)) {
        categoriesBySlug.set(slug, {
          slug,
          label,
          kind: kindFromName(label),
          sortOrder: categoriesBySlug.size,
        });
      }

      for (const pid of productIds) {
        if (seenProducts.has(pid)) continue;
        const p = byId.get(pid);
        if (!p) continue;
        if (p.out_of_stock || p.redirect_to) continue;
        const priceCents = priceCentsFromValue(p.price ?? p.price_full);
        if (priceCents <= 0) continue;
        seenProducts.add(pid);

        itemsOut.push({
          name: (p.label ?? "").trim().slice(0, 120) || "(sin nombre)",
          description: htmlToText(p.description),
          priceCents,
          categorySlug: slug,
          tags: [],
          photoUrl: pickImage(p.image ?? null),
          confidence: 1,
        });
      }
    }
  }

  if (itemsOut.length === 0) return null;

  // Localize images, cayendo a la URL de images.cluvi.com si la descarga
  // server-side falla (p.ej. el CDN limita la IP del servidor). El menú
  // del comensal pinta la foto como background-image, así que la URL
  // remota sirve igual desde el navegador.
  const localized = await localizeImagesWithFallback(
    itemsOut.map((it) => it.photoUrl),
    restaurantId,
  );
  for (let i = 0; i < itemsOut.length; i++) {
    itemsOut[i].photoUrl = localized[i];
  }

  const categoriesOut = Array.from(categoriesBySlug.values()).sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );

  let sourceUrl = originUrl;
  try {
    sourceUrl = new URL(originUrl).origin;
  } catch {
    /* keep raw url */
  }

  return {
    extraction: {
      categories: categoriesOut,
      items: itemsOut,
      notes:
        `Importado directo desde Cluvi: ${itemsOut.length} platos, ` +
        `${categoriesOut.length} categorías.`,
    },
    sourceUrl,
  };
}
