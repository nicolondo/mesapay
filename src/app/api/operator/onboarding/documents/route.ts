import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const MAX_BYTES = 10 * 1024 * 1024;
const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const DocumentKind = z.enum([
  "cedula_rep_legal",
  "rut",
  "camara_comercio",
  "bank_cert",
  "origen_fondos",
  "estados_financieros",
  "estatutos",
  "other",
]);

function uploadDir() {
  // Kept under the same UPLOAD_DIR as menu photos so nginx + activate.sh
  // already serve them. Onboarding docs live in a separate subdir to keep
  // them out of /uploads/ listings if anyone ever indexes them.
  return path.join(
    process.env.UPLOAD_DIR || path.join(process.cwd(), "public", "uploads"),
    "onboarding",
  );
}

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

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "invalid form" }, { status: 400 });
  }
  const file = form.get("file");
  const kindRaw = form.get("kind");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no file" }, { status: 400 });
  }
  const kindParse = DocumentKind.safeParse(kindRaw);
  if (!kindParse.success) {
    return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  }
  const kind = kindParse.data;

  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "archivo demasiado grande (máx 10MB)" },
      { status: 413 },
    );
  }
  const ext = MIME_EXT[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: "formato no soportado (usa JPG, PNG, WebP o PDF)" },
      { status: 415 },
    );
  }

  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const name = `${restaurantId}_${randomBytes(8).toString("hex")}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  await writeFile(path.join(dir, name), buf);

  const doc = await db.kushkiDocument.create({
    data: {
      restaurantId,
      uploadedById: session.user.id ?? null,
      kind,
      fileUrl: `/uploads/onboarding/${name}`,
      fileName: file.name.slice(0, 200),
      mimeType: file.type,
      fileSize: file.size,
    },
  });

  // Bump the restaurant's onboarding status if it was untouched. Helps the
  // settings landing reflect "Documentos cargados" without a manual step.
  await db.restaurant.update({
    where: { id: restaurantId },
    data: {
      kushkiOnboardingStatus: { set: "docs_uploaded" },
    },
  });

  return NextResponse.json({ ok: true, document: doc });
}

export async function GET() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }
  const docs = await db.kushkiDocument.findMany({
    where: { restaurantId },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ documents: docs });
}

export async function DELETE(req: Request) {
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
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }
  const doc = await db.kushkiDocument.findUnique({ where: { id } });
  if (!doc || doc.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  await db.kushkiDocument.delete({ where: { id } });
  // We intentionally leave the file on disk — cheap, and avoids losing it if
  // a deletion was accidental. A cron can sweep orphaned files later.
  return NextResponse.json({ ok: true });
}
