import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { extractPurchaseInvoice } from "@/lib/anthropic";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { expensePrefillFromInvoice } from "@/lib/erp/expenseAi";
import { findSupplierByTaxId } from "@/lib/erp/supplierTaxId";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // la lectura con IA puede tardar

const GATE: ModuleSlug[] = ["accounting"];
const MAX_BYTES = 15 * 1024 * 1024;
// Mismo almacenamiento y formatos que las facturas de compra.
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const EXT_MIME: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
/** Sólo archivos que subió esta ruta (nada de rutas arbitrarias del disco). */
const OWN_FILE = /^\/uploads\/(gasto-[a-f0-9]{16}\.(pdf|jpg|png|webp))$/;

function uploadDir() {
  return process.env.UPLOAD_DIR || path.join(process.cwd(), "public", "uploads");
}

/**
 * Soporte de un gasto (foto o PDF de la factura, cuenta de cobro o recibo).
 *
 *  · `file`: lo guarda junto a las facturas de compra y devuelve su URL.
 *  · `fileUrl`: un soporte ya subido (para leerlo después).
 *  · `read=1`: además lo lee con el extractor de facturas de compra (el
 *    mismo de Compras, sin cambios) y devuelve los campos para PRELLENAR
 *    el gasto: documento, proveedor (si su NIT ya existe, cuál), valores e
 *    IVA. Nada se guarda en el gasto: el operador revisa y guarda.
 *
 * Sin llave de IA configurada responde el archivo con `aiError:
 * "ai_unavailable"` (nunca llama al proveedor de IA).
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "no_file" }, { status: 400 });
  const file = form.get("file");
  const existing = form.get("fileUrl");
  const read = form.get("read") === "1";

  let buf: Buffer;
  let ext: string;
  let fileUrl: string;
  if (file instanceof File) {
    const e = MIME_EXT[file.type];
    if (!e) return NextResponse.json({ error: "bad_format" }, { status: 400 });
    if (file.size > MAX_BYTES || file.size === 0) {
      return NextResponse.json({ error: "bad_size" }, { status: 400 });
    }
    buf = Buffer.from(await file.arrayBuffer());
    ext = e;
    const dir = uploadDir();
    await mkdir(dir, { recursive: true });
    const name = `gasto-${randomBytes(8).toString("hex")}.${ext}`;
    await writeFile(path.join(dir, name), buf);
    fileUrl = `/uploads/${name}`;
  } else if (typeof existing === "string" && OWN_FILE.test(existing)) {
    const m = OWN_FILE.exec(existing)!;
    ext = m[2]!;
    fileUrl = existing;
    try {
      buf = await readFile(path.join(uploadDir(), m[1]!));
    } catch {
      return NextResponse.json({ error: "no_file" }, { status: 404 });
    }
  } else {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }

  if (!read) return NextResponse.json({ fileUrl }, { status: 201 });
  if (!env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ fileUrl, aiError: "ai_unavailable" }, { status: 201 });
  }

  try {
    const extraction = await extractPurchaseInvoice(
      ext === "pdf"
        ? { kind: "pdf", data: buf }
        : { kind: "image", data: buf, mimeType: EXT_MIME[ext]! },
    );
    if (extraction.documentType === "otro" && extraction.confidence === 0) {
      return NextResponse.json({ fileUrl, aiError: "not_a_document" }, { status: 201 });
    }
    const prefill = expensePrefillFromInvoice(extraction, ctx.country);
    // ¿El proveedor ya existe? Por NIT (sin puntos ni DV).
    let supplierId: string | null = null;
    if (prefill.supplierTaxId) {
      const suppliers = await db.supplier.findMany({
        where: { restaurantId: ctx.restaurantId, taxId: { not: null } },
        select: { id: true, taxId: true },
      });
      supplierId = findSupplierByTaxId(suppliers, prefill.supplierTaxId)?.id ?? null;
    }
    return NextResponse.json({ fileUrl, prefill: { ...prefill, supplierId } }, { status: 201 });
  } catch (err) {
    console.error("[expenses/attachments] lectura con IA falló", err);
    return NextResponse.json({ fileUrl, aiError: "ai_failed" }, { status: 201 });
  }
}

export const POST = secureApi(POSTHandler);
