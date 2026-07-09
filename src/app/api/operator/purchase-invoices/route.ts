import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { extractPurchaseInvoice } from "@/lib/anthropic";
import {
  matchInvoice,
  normalizeExtraction,
  type MatchContext,
} from "@/lib/erp/invoiceMatch";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // la extracción con IA puede tardar

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

/** Contexto de matching del comercio (proveedores, insumos, lista de precios). */
async function loadMatchContext(restaurantId: string): Promise<MatchContext> {
  const [suppliers, ingredients, priceList] = await Promise.all([
    db.supplier.findMany({
      where: { restaurantId, active: true },
      select: { id: true, name: true, taxId: true },
    }),
    db.ingredient.findMany({
      where: { restaurantId, active: true },
      select: { id: true, name: true, measureKind: true },
    }),
    db.supplierIngredient.findMany({
      where: { supplier: { restaurantId } },
      select: {
        supplierId: true,
        ingredientId: true,
        id: true,
        presentationLabel: true,
        contentQty: true,
        lastPriceCents: true,
      },
    }),
  ]);
  return {
    suppliers: suppliers.map((s) => ({ id: s.id, name: s.name, nit: s.taxId })),
    ingredients,
    priceList: priceList.map((p) => ({
      supplierId: p.supplierId,
      ingredientId: p.ingredientId,
      supplierItemId: p.id,
      presentationLabel: p.presentationLabel,
      contentQty: p.contentQty,
      lastPriceCents: p.lastPriceCents,
    })),
  };
}

/**
 * Sube una factura de compra (PDF/imagen), la lee con IA y devuelve la
 * extracción emparejada con el catálogo para revisar. NADA se persiste
 * en el catálogo — solo se guarda la carga (PurchaseInvoiceUpload) y la
 * imagen de evidencia.
 */
export async function POST(req: Request) {
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

  const dir = uploadDir();
  await mkdir(dir, { recursive: true });
  const name = `factura-${randomBytes(8).toString("hex")}.${ext}`;
  await writeFile(path.join(dir, name), buf);
  const fileUrl = `/uploads/${name}`;

  // Extracción con IA (solo lectura).
  const source =
    ext === "pdf"
      ? ({ kind: "pdf", data: buf } as const)
      : ({ kind: "image", data: buf, mimeType: file.type } as const);
  const raw = await extractPurchaseInvoice(source);
  const extraction = normalizeExtraction(raw);
  const matchCtx = await loadMatchContext(ctx.restaurantId);
  const match = matchInvoice(extraction, matchCtx);

  const session = await auth();
  const upload = await db.purchaseInvoiceUpload.create({
    data: {
      restaurantId: ctx.restaurantId,
      fileUrl,
      status: "pending",
      extraction,
      createdById: session?.user?.id ?? null,
    },
    select: { id: true },
  });

  return NextResponse.json({
    uploadId: upload.id,
    fileUrl,
    extraction,
    match,
  });
}
