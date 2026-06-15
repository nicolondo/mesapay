/**
 * Justo / OrionEat menu importer.
 *
 * Justo (getjusto.com / orioneat-prod) is a Latin-American ordering
 * platform used by a lot of Colombian restaurants — Delirio, El Cielo,
 * Andrés DC takeout, and a long tail of others. The customer site is a
 * Remix app: the storefront HTML ships with the entire menu inline as
 * `window.__remixContext`. We parse that directly — way more reliable
 * than scraping the rendered DOM (which is React-hydrated and would
 * need a headless browser).
 *
 * Shape we extract from (relevant chunks):
 *
 *   {
 *     state: {
 *       loaderData: {
 *         "pages/Order/Layout/index": {
 *           menuData: {
 *             categories: { [id]: { _id, name, productIds[], index, parentCategory } },
 *             products:   { [id]: { _id, name, description, availabilityAt: { finalPrice, available, visible }, images[], categories[] } },
 *           }
 *         }
 *       }
 *     }
 *   }
 *
 * Prices already arrive in pesos (no decimals), so 24900 = $24.900.
 */

import type { MenuExtraction } from "@/lib/anthropic";
import { localizeImagesWithFallback } from "@/lib/menuImportImages";
import { checkUrlSafe } from "@/lib/ssrf";

type JustoImage = {
  resizedData?: {
    thumbnailURL?: string | null;
    smallURL?: string | null;
    mediumURL?: string | null;
    largeURL?: string | null;
    extraLargeURL?: string | null;
  } | null;
};

type JustoCategoryRef = { _id: string; name?: string | null; index?: number | null };

type JustoProduct = {
  _id: string;
  name?: string | null;
  description?: string | null;
  availabilityAt?: {
    basePrice?: number | null;
    finalPrice?: number | null;
    available?: boolean | null;
    visible?: boolean | null;
  } | null;
  images?: JustoImage[] | null;
  categories?: JustoCategoryRef[] | null;
};

type JustoCategory = {
  _id: string;
  name?: string | null;
  productIds?: string[] | null;
  index?: number | null;
  parentCategory?: string | null;
};

type RemixContext = {
  state?: {
    loaderData?: Record<string, unknown>;
  };
};

const FETCH_TIMEOUT_MS = 15_000;

// Same filter list as the Shopify importer — promotional / catch-all
// buckets that dilute the real menu structure.
const PROMO_PATTERNS = [
  /aniversario/i,
  /promoci/i,
  /recomendad/i,
  /favorit/i,
  /lealtad/i,
  /^todos$/i,
  /^all$/i,
  /^home$/i,
  /exclusiv.*p[áa]gina/i,
  /points?\b/i,
  /^delirio points/i,
];

function isPromotional(title: string): boolean {
  return PROMO_PATTERNS.some((rx) => rx.test(title));
}

function kindFromName(name: string): "starter" | "main" | "side" | "drink" | "dessert" | "other" {
  const s = name.toLowerCase();
  if (
    /bebida|cerveza|vino|licor|jugo|gaseosa|aromat|caf[eé]|limonada|c[oó]ctel|cocktail|smoothie|té|infusi|coctel/i.test(
      s,
    )
  )
    return "drink";
  if (
    /postre|gelato|tiramisu|stromboli|cassata|milhoja|helado|dulce|brownie|cheesecake/i.test(s)
  )
    return "dessert";
  if (
    /entrada|aperitivo|antoj|appetiz|crocant[ií]|focaccia|tapa|carpaccio|ceviche/i.test(s)
  )
    return "starter";
  if (/acompa[ñn]|adicion|side|guarnici|extra|topping|salsa/i.test(s)) return "side";
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

function pickImage(p: JustoProduct): string | null {
  const img = (p.images ?? [])[0];
  const r = img?.resizedData;
  if (!r) return null;
  return r.mediumURL ?? r.largeURL ?? r.smallURL ?? r.extraLargeURL ?? r.thumbnailURL ?? null;
}

function priceCentsFromPesos(pesos: number | null | undefined): number {
  if (pesos == null) return 0;
  if (!isFinite(pesos) || pesos < 0) return 0;
  // Justo stores integer pesos (24900 = $24.900). We store cents.
  return Math.round(pesos * 100);
}

function cleanDescription(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 500);
}

async function fetchHtml(url: string): Promise<string | null> {
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
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Pull out the JSON payload assigned to `window.__remixContext`. */
function extractRemixContext(html: string): RemixContext | null {
  // Loose-ish match: the assignment lands inline in a <script> tag and
  // ends with `;</script>`. The JSON inside can be huge so we anchor on
  // the prefix and lazy-match through to the closing brace + semi.
  const m = html.match(/window\.__remixContext\s*=\s*(\{[\s\S]+?\});\s*<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as RemixContext;
  } catch {
    return null;
  }
}

/** Walk loaderData looking for the menuData shape Justo uses. */
function findMenuData(
  ctx: RemixContext,
): { categories: Record<string, JustoCategory>; products: Record<string, JustoProduct> } | null {
  const ld = ctx.state?.loaderData;
  if (!ld) return null;
  for (const key of Object.keys(ld)) {
    const val = ld[key] as Record<string, unknown> | null | undefined;
    if (!val || typeof val !== "object") continue;
    const md = (val as { menuData?: unknown }).menuData as
      | { categories?: Record<string, JustoCategory>; products?: Record<string, JustoProduct> }
      | undefined;
    if (
      md &&
      md.categories &&
      typeof md.categories === "object" &&
      md.products &&
      typeof md.products === "object"
    ) {
      return { categories: md.categories, products: md.products };
    }
  }
  return null;
}

/**
 * Detect + extract a Justo/OrionEat menu. Returns null if it's not Justo
 * or we couldn't find the embedded state.
 */
export async function tryImportJusto(
  originUrl: string,
  restaurantId: string,
): Promise<{ extraction: MenuExtraction; sourceUrl: string } | null> {
  // Quick host check is cheap but not authoritative — many Justo
  // tenants use vanity domains (deliriorestaurante.com.co). The real
  // signal is the remix context, so we just fetch and parse.
  const html = await fetchHtml(originUrl);
  if (!html) return null;
  // Cheap signature: every Justo site references getjusto.com assets.
  if (!/getjusto\.com|orioneat-prod|__remixContext/.test(html)) return null;

  const ctx = extractRemixContext(html);
  if (!ctx) return null;
  const md = findMenuData(ctx);
  if (!md) return null;

  const { categories, products } = md;

  // Build category map. Skip hidden / promo ones. Preserve Justo's own
  // `index` so the order matches the storefront the operator just saw.
  const usableCategories = Object.values(categories)
    .filter((c) => c.name && !isPromotional(c.name))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  // Resolve product → category. A product's own `categories` array
  // already holds the category metadata, so we prefer that. Fall back
  // to scanning category.productIds in case a product lacks it.
  const productToCat = new Map<string, JustoCategory>();
  for (const c of usableCategories) {
    for (const pid of c.productIds ?? []) {
      if (!productToCat.has(pid)) productToCat.set(pid, c);
    }
  }

  const categoriesBySlug = new Map<
    string,
    { slug: string; label: string; kind: ReturnType<typeof kindFromName>; sortOrder: number }
  >();
  const itemsOut: MenuExtraction["items"] = [];

  // Sort products by category index → name so the review screen reads
  // naturally and dishes within the same category cluster together.
  const sortedProducts = Object.values(products).sort((a, b) => {
    const ca = productToCat.get(a._id);
    const cb = productToCat.get(b._id);
    const ai = ca?.index ?? Number.MAX_SAFE_INTEGER;
    const bi = cb?.index ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });

  for (const p of sortedProducts) {
    const av = p.availabilityAt;
    if (av && (av.visible === false || av.available === false)) continue;
    const pesos = av?.finalPrice ?? av?.basePrice ?? null;
    const priceCents = priceCentsFromPesos(pesos);
    if (priceCents <= 0) continue;

    // Category selection: explicit product.categories[0] is usually the
    // primary one; otherwise the productIds reverse-map; final fallback
    // is "Otros".
    let catName: string | null =
      (p.categories ?? []).find((c) => c.name && !isPromotional(c.name))?.name ?? null;
    if (!catName) {
      const fromMap = productToCat.get(p._id);
      catName = fromMap?.name ?? null;
    }
    if (!catName) catName = "Otros";

    const slug = slugify(catName);
    if (!categoriesBySlug.has(slug)) {
      categoriesBySlug.set(slug, {
        slug,
        label: catName,
        kind: kindFromName(catName),
        sortOrder: categoriesBySlug.size,
      });
    }

    itemsOut.push({
      name: (p.name ?? "").trim().slice(0, 120) || "(sin nombre)",
      description: cleanDescription(p.description),
      priceCents,
      categorySlug: slug,
      tags: [],
      photoUrl: pickImage(p),
      confidence: 1,
    });
  }

  if (itemsOut.length === 0) return null;

  // Localize images, cayendo a la URL de tofuu.getjusto.com si la descarga
  // server-side falla. El menú del comensal pinta la foto como
  // background-image, así que la URL remota sirve igual desde el navegador.
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
        `Importado directo desde Justo/OrionEat: ${itemsOut.length} platos, ` +
        `${categoriesOut.length} categorías.`,
    },
    sourceUrl,
  };
}
