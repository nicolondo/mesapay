import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { extractMenuFromDocument } from "@/lib/anthropic";
import { checkUrlSafe } from "@/lib/ssrf";

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

  const extraction = await (async () => {
    if (contentType === "application/pdf") {
      return extractMenuFromDocument({ kind: "pdf", data: buffer });
    }
    if (contentType.startsWith("image/")) {
      return extractMenuFromDocument({
        kind: "image",
        data: buffer,
        mimeType: contentType,
      });
    }
    // HTML path
    const html = buffer.toString("utf-8");
    return extractMenuFromDocument({
      kind: "html",
      text: html,
      sourceUrl: finalUrl,
    });
  })();

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
