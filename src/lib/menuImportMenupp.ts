/**
 * Menüpp menu importer.
 *
 * Menüpp (menupp.co) is a Colombian digital-menu / ordering platform. The
 * storefront at `https://menupp.co/<slug>/...` is a Quasar (Vue) SPA: the
 * HTML is an empty shell (`<div id=q-app>`) and the menu hydrates from
 * Firebase/Firestore on the client. Running AI over the shell yields
 * nothing, so we read Firestore's public REST API directly — same idea as
 * the Cluvi / Justo / Shopify fast paths.
 *
 * Firestore (project `menupp-next`, discovered from the app bundle's
 * firebaseConfig). Public read rules allow anonymous GETs on the paths we
 * need. Structure:
 *
 *   restaurants/{slug}
 *     locations/{locationId}
 *       menus/{menuId}                         ← Comida, Bebidas, Licores, …
 *         categories/{categoryId}              ← { name, order, disabled }
 *         products/{productId}                 ← { product_name, description,
 *                                                  price:[{price:<int pesos>}],
 *                                                  product_category, image:[url],
 *                                                  disabled, hidePrice }
 *
 * Prices are integer pesos (12900 = $12.900). We store integer cents.
 * Products link to their category via `product_category` (a category id).
 */

import type { MenuExtraction } from "@/lib/anthropic";
import { localizeImagesWithFallback } from "@/lib/menuImportImages";
import { checkUrlSafe } from "@/lib/ssrf";

// Fixed, public host — never derived from user input, so no SSRF surface on
// the host. Only the {slug}/{id} path segments come from the URL and are
// sanitized to safe Firestore id chars before use.
const FS_BASE =
  "https://firestore.googleapis.com/v1/projects/menupp-next/databases/(default)/documents";
const FETCH_TIMEOUT_MS = 15_000;
// Bound the crawl so a pathological account can't make us page forever.
const MAX_PAGES = 8;
const PAGE_SIZE = 300;

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
  if (/\b(ron|gin|vino|licor|jugo|agua|t[eé]|mezcla|copa|sidra)s?\b/i.test(s))
    return "drink";
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
  if (/desayuno/i.test(s)) return "main";
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

/** Strip any HTML in descriptions down to plain text (cap at 500 chars). */
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
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return s || null;
}

/** Firestore id chars only — the slug/ids come from the user URL. */
function cleanFsId(s: string): string {
  return decodeURIComponent(s).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 200);
}

/** Parse a menupp.co storefront URL into the restaurant slug. */
function parseMenuppSlug(url: string): string | null {
  let host = "";
  let path = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname;
  } catch {
    return null;
  }
  if (host !== "menupp.co" && !host.endsWith(".menupp.co")) return null;
  const seg = path.split("/").filter(Boolean)[0] ?? "";
  const slug = cleanFsId(seg);
  // Reserved app routes that aren't restaurant slugs.
  if (!slug || ["assets", "icons", "api", "admin"].includes(slug)) return null;
  return slug;
}

// ── Firestore REST value helpers ──────────────────────────────────────────

type FsValue = Record<string, unknown>;
type FsDoc = { name: string; fields?: Record<string, FsValue> };

/** Unwrap a Firestore typed value into a plain JS value. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fv(v: FsValue | undefined | null): any {
  if (v == null) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) {
    const arr = (v.arrayValue as { values?: FsValue[] })?.values ?? [];
    return arr.map((x) => fv(x));
  }
  if ("mapValue" in v) {
    const fields =
      (v.mapValue as { fields?: Record<string, FsValue> })?.fields ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(fields)) out[k] = fv(val);
    return out;
  }
  return null;
}

async function fsFetch(url: string): Promise<unknown | null> {
  const safe = await checkUrlSafe(url);
  if (!safe.ok) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** GET a single document's fields, or null if missing / forbidden. */
async function fsGetDoc(
  docPath: string,
): Promise<Record<string, FsValue> | null> {
  const data = (await fsFetch(`${FS_BASE}/${docPath}`)) as FsDoc | null;
  return data?.fields ?? null;
}

/** List a collection's documents (paginated), returning {id, fields}. */
async function fsListCollection(
  collPath: string,
): Promise<Array<{ id: string; fields: Record<string, FsValue> }>> {
  const out: Array<{ id: string; fields: Record<string, FsValue> }> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
    if (pageToken) qs.set("pageToken", pageToken);
    const data = (await fsFetch(`${FS_BASE}/${collPath}?${qs}`)) as {
      documents?: FsDoc[];
      nextPageToken?: string;
    } | null;
    if (!data) break;
    for (const d of data.documents ?? []) {
      out.push({
        id: d.name.split("/").pop() ?? "",
        fields: d.fields ?? {},
      });
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return out;
}

// ── Importer ───────────────────────────────────────────────────────────────

type CatBucket = {
  slug: string;
  label: string;
  kind: ReturnType<typeof kindFromName>;
  sortOrder: number;
};

/** First positive price (in cents) from a Menüpp `price` array. */
function priceCentsFromArray(priceArr: unknown): number {
  if (!Array.isArray(priceArr)) return 0;
  for (const entry of priceArr) {
    const pesos = (entry as { price?: unknown })?.price;
    const n = typeof pesos === "number" ? pesos : Number(pesos);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100);
  }
  return 0;
}

/**
 * Detect + extract a Menüpp menu. Returns null if the URL isn't a menupp.co
 * storefront or we couldn't pull a usable menu.
 */
export async function tryImportMenupp(
  originUrl: string,
  restaurantId: string,
): Promise<{ extraction: MenuExtraction; sourceUrl: string } | null> {
  const slug = parseMenuppSlug(originUrl);
  if (!slug) return null;

  // Validate it's a real Menüpp restaurant before crawling.
  const restaurant = await fsGetDoc(`restaurants/${slug}`);
  if (!restaurant) return null;

  const locations = await fsListCollection(
    `restaurants/${slug}/locations`,
  );
  if (locations.length === 0) return null;

  const categoriesBySlug = new Map<string, CatBucket>();
  const itemsOut: MenuExtraction["items"] = [];
  const seenNames = new Set<string>();
  let menuCount = 0;

  for (const loc of locations) {
    const menus = await fsListCollection(
      `restaurants/${slug}/locations/${loc.id}/menus`,
    );
    // Menüpp orders menus with a numeric `order` field.
    menus.sort((a, b) => (fv(a.fields.order) ?? 0) - (fv(b.fields.order) ?? 0));

    for (const menu of menus) {
      if (fv(menu.fields.hide) === true || fv(menu.fields.active) === false)
        continue;
      const menuName = (fv(menu.fields.name) ?? "").toString().trim();
      const base = `restaurants/${slug}/locations/${loc.id}/menus/${menu.id}`;

      const [cats, prods] = await Promise.all([
        fsListCollection(`${base}/categories`),
        fsListCollection(`${base}/products`),
      ]);

      // Category id → { name, order }. Skip disabled categories.
      const catById = new Map<string, { name: string; order: number }>();
      for (const c of cats) {
        if (fv(c.fields.disabled) === true) continue;
        const name = (fv(c.fields.name) ?? "").toString().trim();
        catById.set(c.id, { name, order: fv(c.fields.order) ?? 0 });
      }

      // Group products by category, then emit categories in their order so
      // the imported menu keeps Menüpp's structure.
      const prodsByCat = new Map<string, typeof prods>();
      for (const p of prods) {
        const catId = (fv(p.fields.product_category) ?? "").toString();
        const arr = prodsByCat.get(catId) ?? [];
        arr.push(p);
        prodsByCat.set(catId, arr);
      }

      const orderedCatIds = [...catById.keys()].sort(
        (a, b) => catById.get(a)!.order - catById.get(b)!.order,
      );
      // Append a synthetic bucket for products whose category is missing.
      const catIdsToEmit = [...orderedCatIds];
      for (const catId of prodsByCat.keys()) {
        if (!catById.has(catId)) catIdsToEmit.push(catId);
      }

      for (const catId of catIdsToEmit) {
        const products = prodsByCat.get(catId);
        if (!products || products.length === 0) continue;

        const rawLabel =
          catById.get(catId)?.name?.trim() || menuName || "Otros";
        if (isPromotional(rawLabel)) continue;
        const cslug = slugify(rawLabel);
        if (!categoriesBySlug.has(cslug)) {
          categoriesBySlug.set(cslug, {
            slug: cslug,
            label: rawLabel,
            kind: kindFromName(rawLabel),
            sortOrder: categoriesBySlug.size,
          });
        }

        for (const p of products) {
          const f = p.fields;
          if (fv(f.disabled) === true) continue;
          const name = (fv(f.product_name) ?? "").toString().trim();
          if (!name) continue;
          const key = name.toLowerCase();
          if (seenNames.has(key)) continue; // dedupe across menus
          const priceCents = priceCentsFromArray(fv(f.price));
          if (priceCents <= 0) continue;
          seenNames.add(key);

          const images = fv(f.image);
          const photoUrl =
            Array.isArray(images) && typeof images[0] === "string"
              ? images[0]
              : null;

          itemsOut.push({
            name: name.slice(0, 120),
            description: htmlToText(fv(f.description)),
            priceCents,
            categorySlug: cslug,
            tags: [],
            photoUrl,
            confidence: 1,
          });
        }
      }
      menuCount++;
    }
  }

  if (itemsOut.length === 0) return null;

  // Download/localize external photos (cloudfront .webp), with fallback to
  // the remote URL if the server-side download fails.
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
        `Importado directo desde Menüpp: ${itemsOut.length} platos, ` +
        `${categoriesOut.length} categorías` +
        (menuCount > 1 ? ` (${menuCount} menús combinados).` : "."),
    },
    sourceUrl,
  };
}
