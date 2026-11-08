import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { writeFile, mkdir, unlink } from "fs/promises";
import path from "path";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { extractPurchaseInvoice } from "@/lib/anthropic";
import { InvoiceExtractionError } from "@/lib/erp/invoiceExtractionError";
import {
  matchInvoice,
  normalizeExtraction,
} from "@/lib/erp/invoiceMatch";
import { loadInvoiceMatchContext } from "@/lib/erp/invoiceMatchContext";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";
export const maxDuration = 540; // shared extraction deadline is 480 seconds

const GATE: ModuleSlug[] = ["purchasing"];
const MAX_BYTES = 15 * 1024 * 1024;
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function uploadDir() {
  return process.env.UPLOAD_DIR || path.join(process.cwd(), "public", "uploads");
}

/**
 * Sube una factura de compra (PDF/imagen), la lee con IA y devuelve la
 * extracción emparejada con el catálogo para revisar. NADA se persiste
 * en el catálogo — solo se guarda la carga (PurchaseInvoiceUpload) y la
 * imagen de evidencia.
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  const ext = MIME_EXT[file.type];
  if (!ext) {
    return NextResponse.json({ error: "bad_format" }, { status: 400 });
  }
  if (file.size > MAX_BYTES || file.size === 0) {
    return NextResponse.json({ error: "bad_size" }, { status: 400 });
  }
  const buf = Buffer.from(await file.arrayBuffer());

  // Extracción con IA (solo lectura).
  const source =
    ext === "pdf"
      ? ({ kind: "pdf", data: buf } as const)
      : ({ kind: "image", data: buf, mimeType: file.type } as const);
  let raw;
  try {
    raw = await extractPurchaseInvoice(source);
  } catch (error) {
    if (error instanceof InvoiceExtractionError) {
      return NextResponse.json({ error: error.code }, { status: error.code === "ai_timeout" ? 504 : 502 });
    }
    throw error;
  }
  if (raw.documentType === "otro") {
    return NextResponse.json({ error: "not_a_document" }, { status: 422 });
  }
  const extraction = normalizeExtraction(raw);
  if (!extraction.lines.length) {
    return NextResponse.json({ error: "no_lines" }, { status: 422 });
  }
  const matchCtx = await loadInvoiceMatchContext(ctx.restaurantId, extraction.lines.map((line) => line.description));
  const match = matchInvoice(extraction, matchCtx);

  // A failed reading must not become a pending $0 invoice or leave an orphan
  // attachment. Only persist the evidence after extraction and matching succeed.
  const session = await auth();
  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const name = `factura-${randomBytes(8).toString("hex")}.${ext}`;
  const savedPath = path.join(dir, name);
  const fileUrl = `/uploads/${name}`;
  await writeFile(savedPath, buf);
  let upload;
  try {
    upload = await db.purchaseInvoiceUpload.create({
      data: {
        restaurantId: ctx.restaurantId,
        fileUrl,
        status: "pending",
        extraction,
        createdById: session?.user?.id ?? null,
      },
      select: { id: true },
    });
  } catch (error) {
    await unlink(savedPath).catch(() => {
      console.error("purchase_invoice_attachment_cleanup_failed");
    });
    throw error;
  }

  return NextResponse.json({
    uploadId: upload.id,
    fileUrl,
    extraction,
    match,
  });
}

export const POST = secureApi(POSTHandler);
