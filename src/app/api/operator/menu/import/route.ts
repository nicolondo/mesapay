import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { extractMenuFromDocument } from "@/lib/anthropic";
import { getRestaurantMenuTags } from "@/lib/menuTags";

// Anthropic's PDF input cap is 32 MB / 100 pages. We allow 45 MB at
// the upload edge so a scanned wine list with image-heavy pages can
// land before we trim / re-encode; the model API call itself may
// still 4xx if the PDF is too big once base64'd. Most cartas land
// under 10 MB so this only matters for the edge case.
// Anthropic limita PDFs a 32 MB; más que eso el modelo lo rechaza igual.
const MAX_BYTES = 32 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/**
 * One-shot upload + extract. We don't persist the file; the model runs
 * on the in-memory buffer and we hand the structured result back to the
 * client for review. The operator confirms the final shape and we create
 * the rows in /confirm.
 *
 * We also surface existing categories so the client can match-by-slug
 * during review and not create duplicates.
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

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "invalid_form" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "file_too_large", message: "Máximo 45 MB." },
      { status: 413 },
    );
  }
  if (!ALLOWED_MIMES.has(file.type)) {
    return NextResponse.json(
      { error: "unsupported_format", message: "Usa PDF, JPG, PNG o WebP." },
      { status: 415 },
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const tags = await getRestaurantMenuTags(restaurantId);
  const extraction = await extractMenuFromDocument(
    file.type === "application/pdf"
      ? { kind: "pdf", data: buffer }
      : { kind: "image", data: buffer, mimeType: file.type },
    tags.map((t) => t.slug),
  );

  // Provide the existing categories so the review UI can suggest reuse.
  const existingCategories = await db.category.findMany({
    where: { restaurantId },
    orderBy: { sortOrder: "asc" },
    select: { id: true, slug: true, label: true, kind: true },
  });

  return NextResponse.json({
    ok: true,
    extraction,
    existingCategories,
  });
}
