/**
 * Shopify-storefront menu importer.
 *
 * Many Colombian restaurants (Il Forno, Crepes & Waffles, Andrés DC, etc.)
 * run their carta on Shopify. Their public storefront exposes structured
 * JSON endpoints that beat anything we'd ever pull out of a rendered HTML
 * page: `/products.json` returns every product with title, description,
 * variants (prices), images, etc. `/collections.json` returns the
 * category structure.
 *
 * When we detect Shopify on a URL the user pasted, we skip the AI
 * extractor entirely and build the menu directly. Faster, cheaper, more
 * accurate, and we get every dish + photo without missing items.
 */

import type { MenuExtraction } from "@/lib/anthropic";
import { downloadMenuImages } from "@/lib/menuImportImages";
import { checkUrlSafe } from "@/lib/ssrf";

type ShopifyVariant = {
  id: number;
  title?: string;
  price: string; // "31900.00"
  available?: boolean;
};

type ShopifyImage = {
  id: number;
  src: string;
};

type ShopifyProduct = {
  id: number;
  title: string;
  handle: string;
  body_html?: string | null;
  product_type?: string | null;
  variants: ShopifyVariant[];
  images: ShopifyImage[];
  tags?: string | string[];
};

type ShopifyCollection = {
  id: number;
  handle: string;
  title: string;
  products_count: number;
};

const FETCH_TIMEOUT_MS = 15_000;
// Collections that are catch-alls, promotional, or loyalty programs.
// These tend to overlap with the "real" categories and dilute the menu.
const PROMO_PATTERNS = [
  /aniversario/i,
  /^especiales\b/i,
  /promoci/i,
  /recomendad/i,
  /favorit/i,
  /lealtad/i,
  /^todos$/i,
  /^all$/i,
  /^home$/i,
  /^frontpage$/i,
  /gourmet/i,
  /nuevas\s+experiencias/i,
  /del\s+mes\b/i,
  /^mes\b/i,
];

function isPromotional(title: string): boolean {
  return PROMO_PATTERNS.some((rx) => rx.test(title));
}

/** Classify a Colombian category name into our enum. */
function kindFromName(name: string): "starter" | "main" | "side" | "drink" | "dessert" | "other" {
  const s = name.toLowerCase();
  if (
    /bebida|cerveza|vino|licor|jugo|gaseosa|aromat|caf[eé]|limonada|c[oó]ctel|cocktail|smoothie|té|infusi/i.test(
      s,
    )
  )
    return "drink";
  if (/postre|gelato|tiramisu|stromboli|cassata|milhoja|helado|dulce|brownie|cheesecake/i.test(s))
    return "dessert";
  if (/entrada|aperitivo|antoj|appetiz|crocant[ií]|focaccia|tapa|carpaccio/i.test(s))
    return "starter";
  if (/acompa[ñn]|adicion|side|guarnici|extra|topping/i.test(s)) return "side";
  return "main";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "categoria";
}

/** Strip Shopify body_html down to plain text, no Word junk. */
function cleanBody(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.slice(0, 500);
}

function priceToCents(p: string | number | undefined): number {
  if (p == null) return 0;
  const n = typeof p === "string" ? parseFloat(p) : p;
  if (!isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const safe = await checkUrlSafe(url);
  if (!safe.ok) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        accept: "application/json",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect + extract a Shopify storefront menu. Returns null if the site
 * isn't Shopify (or if we couldn't get a useful response). On success,
 * returns the menu in the same shape the AI extractor uses, with photos
 * already downloaded to local /uploads/ paths.
 */
export async function tryImportShopify(
  originUrl: string,
  restaurantId: string,
): Promise<{ extraction: MenuExtraction; sourceUrl: string } | null> {
  let origin: string;
  try {
    origin = new URL(originUrl).origin;
  } catch {
    return null;
  }

  // Probe — is this Shopify? products.json is publicly exposed on every
  // Shopify storefront. If we get a JSON response with a `products` array,
  // we're in.
  const probe = await fetchJson<{ products?: ShopifyProduct[] }>(
    `${origin}/products.json?limit=1`,
  );
  if (!probe || !Array.isArray(probe.products)) return null;

  // Pull all products (paginate, 250 max per page per Shopify docs).
  const products: ShopifyProduct[] = [];
  for (let page = 1; page <= 10; page++) {
    const resp = await fetchJson<{ products?: ShopifyProduct[] }>(
      `${origin}/products.json?limit=250&page=${page}`,
    );
    const batch = resp?.products ?? [];
    if (batch.length === 0) break;
    products.push(...batch);
    if (batch.length < 250) break;
  }
  if (products.length === 0) return null;

  // Pull collections + their member products so we can assign categories.
  const collectionsResp = await fetchJson<{ collections?: ShopifyCollection[] }>(
    `${origin}/collections.json?limit=250`,
  );
  const allCollections = collectionsResp?.collections ?? [];
  // Keep only non-empty, non-promotional collections. Sort alphabetically
  // so the assignment is deterministic.
  const realCollections = allCollections
    .filter((c) => c.products_count > 0 && !isPromotional(c.title))
    .sort((a, b) => a.title.localeCompare(b.title));

  // Fetch each collection's product list. Concurrency-capped so we don't
  // hammer their servers.
  const productToCollection = new Map<number, ShopifyCollection>();
  const concurrency = 4;
  let idx = 0;
  async function worker() {
    while (idx < realCollections.length) {
      const c = realCollections[idx++];
      const resp = await fetchJson<{ products?: { id: number }[] }>(
        `${origin}/collections/${c.handle}/products.json?limit=250`,
      );
      for (const p of resp?.products ?? []) {
        // First-write wins so a product lands in its first (alphabetical)
        // non-promotional collection. Subsequent matches are ignored,
        // which avoids products jumping around between similar categories.
        if (!productToCollection.has(p.id)) {
          productToCollection.set(p.id, c);
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, realCollections.length) }, () =>
      worker(),
    ),
  );

  // Build the menu structure. Each product → first matching collection,
  // falling back to product_type, then "Otros".
  const categoriesBySlug = new Map<
    string,
    { slug: string; label: string; kind: ReturnType<typeof kindFromName>; sortOrder: number }
  >();
  function categoryFor(product: ShopifyProduct): {
    slug: string;
    label: string;
  } {
    const fromCol = productToCollection.get(product.id);
    if (fromCol) {
      return { slug: slugify(fromCol.title), label: fromCol.title };
    }
    if (product.product_type && product.product_type.trim()) {
      return {
        slug: slugify(product.product_type),
        label: product.product_type.trim(),
      };
    }
    return { slug: "otros", label: "Otros" };
  }

  const itemsOut: MenuExtraction["items"] = [];
  for (const p of products) {
    const cat = categoryFor(p);
    if (!categoriesBySlug.has(cat.slug)) {
      categoriesBySlug.set(cat.slug, {
        slug: cat.slug,
        label: cat.label,
        kind: kindFromName(cat.label),
        sortOrder: categoriesBySlug.size,
      });
    }
    // Use the first variant's price as the headline price. Variants with
    // different prices (e.g., size options) collapse to one item — the
    // operator can add modifiers manually if needed.
    const headlineVariant = p.variants[0];
    const priceCents = priceToCents(headlineVariant?.price);
    if (priceCents <= 0) continue; // skip out-of-stock / no-price items
    if (headlineVariant && headlineVariant.available === false) continue;

    itemsOut.push({
      name: p.title.trim().slice(0, 120),
      description: cleanBody(p.body_html),
      priceCents,
      categorySlug: cat.slug,
      tags: [],
      photoUrl: p.images[0]?.src ?? null,
      confidence: 1, // structured data — no inference involved
    });
  }

  // Download all photos in parallel (existing helper handles SSRF + caps).
  const localUrls = await downloadMenuImages(
    itemsOut.map((it) => it.photoUrl),
    restaurantId,
  );
  for (let i = 0; i < itemsOut.length; i++) {
    itemsOut[i].photoUrl = localUrls[i];
  }

  const categoriesOut = Array.from(categoriesBySlug.values()).sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );

  return {
    extraction: {
      categories: categoriesOut,
      items: itemsOut,
      notes:
        `Importado directo desde Shopify: ${products.length} productos, ` +
        `${categoriesOut.length} categorías.`,
    },
    sourceUrl: origin,
  };
}
