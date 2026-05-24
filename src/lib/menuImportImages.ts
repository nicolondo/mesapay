import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";
import { checkUrlSafe } from "@/lib/ssrf";

/**
 * Download an external image discovered during menu extraction and save
 * it under the restaurant's uploads dir. Returns the local URL (the
 * `/uploads/...` form we serve via nginx) or null if anything failed.
 *
 * Why download instead of just storing the external URL on MenuItem?
 *  - Restaurants change their websites; we'd lose the photos.
 *  - External hosts can rate-limit / hotlink-block our diners.
 *  - We can serve the same file size that the rest of the menu uses,
 *    not whatever giant 4MB hero the marketing page had.
 *
 * Constraints:
 *  - Same SSRF guard as the URL fetcher.
 *  - 8 MB max per image.
 *  - Whitelist mime types.
 *  - 10 s timeout per image.
 */

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function uploadsRoot(): string {
  return (
    process.env.UPLOAD_DIR ?? path.join(process.cwd(), "public", "uploads")
  );
}

export async function downloadMenuImage(
  externalUrl: string,
  restaurantId: string,
): Promise<string | null> {
  const safe = await checkUrlSafe(externalUrl);
  if (!safe.ok) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(externalUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
  } catch {
    clearTimeout(timer);
    return null;
  }
  clearTimeout(timer);

  if (!res.ok) return null;

  // Re-check after redirects.
  const finalUrl = res.url || externalUrl;
  if (finalUrl !== externalUrl) {
    const recheck = await checkUrlSafe(finalUrl);
    if (!recheck.ok) return null;
  }

  const ctype = (res.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const ext = MIME_EXT[ctype];
  if (!ext) return null;

  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
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
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const buffer = Buffer.concat(chunks);

  const dir = path.join(uploadsRoot(), "menu-import");
  try {
    await mkdir(dir, { recursive: true });
    const filename = `${restaurantId}_${randomBytes(8).toString("hex")}.${ext}`;
    await writeFile(path.join(dir, filename), buffer);
    return `/uploads/menu-import/${filename}`;
  } catch {
    return null;
  }
}

/**
 * Bulk-download with concurrency limit so an HTML page with 30 dishes
 * doesn't open 30 sockets at once. Preserves input order.
 */
export async function downloadMenuImages(
  urls: (string | null | undefined)[],
  restaurantId: string,
  concurrency = 4,
): Promise<(string | null)[]> {
  const result: (string | null)[] = new Array(urls.length).fill(null);
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= urls.length) return;
      const u = urls[i];
      if (!u) {
        result[i] = null;
        continue;
      }
      result[i] = await downloadMenuImage(u, restaurantId);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, urls.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return result;
}
