import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { extractMenuFromDocument } from "@/lib/anthropic";
import { getRestaurantMenuTags } from "@/lib/menuTags";
import { checkUrlSafe } from "@/lib/ssrf";
import { downloadMenuImages } from "@/lib/menuImportImages";
import { tryImportShopify } from "@/lib/menuImportShopify";
import { tryImportJusto } from "@/lib/menuImportJusto";

const schema = z.object({
  url: z.string().trim().min(1).max(2000),
});

const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/html",
  "application/xhtml+xml",
]);

/**
 * Fetch a public URL and extract the menu from whatever the response is.
 *
 * Risks we guard against:
 *  - SSRF (private IPs, file://, gopher://). See checkUrlSafe.
 *  - Resource exhaustion: hard cap on bytes + timeout.
 *  - Untrusted Content-Type: only PDF, common image types, and HTML.
 *  - Huge HTML pages (marketing sites with embedded videos): the
 *    extractor itself slices to 250k chars after stripping scripts.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" &&
      session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  // Trim + add https:// if user pasted "restaurante.com/carta"
  let url = parsed.data.url.trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;

  const safe = await checkUrlSafe(url);
  if (!safe.ok) {
    return NextResponse.json(
      { error: "unsafe_url", message: safe.reason },
      { status: 400 },
    );
  }

  // Fast path: many Colombian restaurants run their carta on Shopify
  // (Il Forno, Crepes & Waffles, etc.). Their public /products.json
  // endpoint gives us every dish with title, description, price, image
  // — beats any AI extraction off the rendered HTML, which is often a
  // SPA that lazy-loads only a handful of items. If we detect Shopify
  // we short-circuit the AI path entirely.
  try {
    const shopify = await tryImportShopify(url, restaurantId);
    if (shopify) {
      const existingCategories = await db.category.findMany({
        where: { restaurantId },
        orderBy: { sortOrder: "asc" },
        select: { id: true, slug: true, label: true, kind: true },
      });
      return NextResponse.json({
        ok: true,
        extraction: shopify.extraction,
        existingCategories,
        sourceUrl: shopify.sourceUrl,
        contentType: "application/shopify",
      });
    }
  } catch {
    // If the Shopify path explodes for any reason, fall through to the
    // generic fetch+AI flow — better to import something than nothing.
  }

  // Same idea for Justo / OrionEat (getjusto.com): the storefront is a
  // Remix app that ships the entire menu inline as window.__remixContext.
  // We parse it directly — beats AI on a hydrated React DOM where prices
  // and dish names aren't visible until JS runs.
  try {
    const justo = await tryImportJusto(url, restaurantId);
    if (justo) {
      const existingCategories = await db.category.findMany({
        where: { restaurantId },
        orderBy: { sortOrder: "asc" },
        select: { id: true, slug: true, label: true, kind: true },
      });
      return NextResponse.json({
        ok: true,
        extraction: justo.extraction,
        existingCategories,
        sourceUrl: justo.sourceUrl,
        contentType: "application/justo",
      });
    }
  } catch {
    /* fall through */
  }

  let resp: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      resp = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          // Some sites serve a different page to bots. Pretend to be a
          // recent Chrome on Mac so we get the regular menu HTML.
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          accept:
            "text/html,application/xhtml+xml,application/pdf,image/avif,image/webp,image/apng,*/*;q=0.8",
        },
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return NextResponse.json(
      {
        error: "fetch_failed",
        message:
          err instanceof Error && err.name === "AbortError"
            ? "El sitio tardó demasiado en responder."
            : "No pudimos descargar el contenido.",
      },
      { status: 502 },
    );
  }

  if (!resp.ok) {
    return NextResponse.json(
      { error: "fetch_failed", message: `HTTP ${resp.status}` },
      { status: 502 },
    );
  }

  // After redirects, re-check the final URL against the SSRF guard.
  const finalUrl = resp.url || url;
  if (finalUrl !== url) {
    const recheck = await checkUrlSafe(finalUrl);
    if (!recheck.ok) {
      return NextResponse.json(
        { error: "unsafe_redirect", message: recheck.reason },
        { status: 400 },
      );
    }
  }

  const rawContentType = resp.headers.get("content-type") ?? "";
  const contentType = rawContentType.split(";")[0].trim().toLowerCase();
  if (!ALLOWED_MIMES.has(contentType)) {
    return NextResponse.json(
      {
        error: "unsupported_format",
        message: `Tipo de contenido no soportado: ${contentType || "desconocido"}.`,
      },
      { status: 415 },
    );
  }

  // Stream the body with a byte cap. fetch() in Node gives us a stream
  // we can pull chunk by chunk.
  let buffer: Buffer;
  try {
    const reader = resp.body?.getReader();
    if (!reader) throw new Error("no_body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return NextResponse.json(
          { error: "too_large", message: "El recurso supera 15 MB." },
          { status: 413 },
        );
      }
      chunks.push(value);
    }
    buffer = Buffer.concat(chunks);
  } catch {
    return NextResponse.json(
      { error: "read_failed", message: "No pudimos leer el contenido." },
      { status: 502 },
    );
  }

  const restaurantTags = await getRestaurantMenuTags(restaurantId);
  const allowedTagSlugs = restaurantTags.map((t) => t.slug);
  const extraction = await (async () => {
    if (contentType === "application/pdf") {
      return extractMenuFromDocument(
        { kind: "pdf", data: buffer },
        allowedTagSlugs,
      );
    }
    if (contentType.startsWith("image/")) {
      return extractMenuFromDocument(
        {
          kind: "image",
          data: buffer,
          mimeType: contentType,
        },
        allowedTagSlugs,
      );
    }
    // HTML path
    const html = buffer.toString("utf-8");
    return extractMenuFromDocument(
      {
        kind: "html",
        text: html,
        sourceUrl: finalUrl,
      },
      allowedTagSlugs,
    );
  })();

  // Download any external photo URLs Claude found and rewrite to local
  // paths. Done here so the operator sees the actual thumbnails during
  // review and confirm is fast (no more downloads needed).
  if (extraction.items.some((it) => it.photoUrl)) {
    const localUrls = await downloadMenuImages(
      extraction.items.map((it) => it.photoUrl),
      restaurantId,
    );
    extraction.items = extraction.items.map((it, i) => ({
      ...it,
      photoUrl: localUrls[i],
    }));
  }

  const existingCategories = await db.category.findMany({
    where: { restaurantId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, slug: true, label: true, kind: true },
  });

  return NextResponse.json({
    ok: true,
    extraction,
    existingCategories,
    sourceUrl: finalUrl,
    contentType,
  });
}
