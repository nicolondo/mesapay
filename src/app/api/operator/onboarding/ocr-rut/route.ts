import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { extractRutData } from "@/lib/anthropic";

const bodySchema = z.object({
  documentId: z.string().min(1),
});

/**
 * Reads a previously-uploaded RUT and extracts legal name + tax id + contact
 * info via Claude. Persists the extracted fields on the document row so a
 * second extraction is cheap if the operator re-opens the wizard.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const doc = await db.kushkiDocument.findUnique({
    where: { id: parsed.data.documentId },
  });
  if (!doc || doc.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (doc.kind !== "rut") {
    return NextResponse.json(
      { error: "document is not a RUT" },
      { status: 400 },
    );
  }

  const uploadsRoot =
    process.env.UPLOAD_DIR || path.join(process.cwd(), "public", "uploads");
  const rel = doc.fileUrl.replace(/^\/uploads\//, "");
  const abs = path.join(uploadsRoot, rel);
  let buffer: Buffer;
  try {
    buffer = await readFile(abs);
  } catch {
    return NextResponse.json({ error: "file unreadable" }, { status: 500 });
  }

  const isPdf = doc.mimeType === "application/pdf";
  const extracted = await extractRutData(
    isPdf
      ? { kind: "pdf", data: buffer }
      : { kind: "image", data: buffer, mimeType: doc.mimeType },
  );

  await db.kushkiDocument.update({
    where: { id: doc.id },
    data: { extractedFields: extracted },
  });

  return NextResponse.json({ ok: true, extracted });
}
