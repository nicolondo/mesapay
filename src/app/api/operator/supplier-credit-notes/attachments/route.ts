import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { env } from "@/lib/env";
import { extractPurchaseInvoice } from "@/lib/anthropic";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { InvoiceExtractionError } from "@/lib/erp/invoiceExtractionError";
import { CREDIT_NOTE_GATE } from "@/lib/erp/supplierCreditNoteApi";
import { creditNotePrefillFromInvoice } from "@/lib/erp/supplierCreditNoteAi";
import { resolvePrefillRefs } from "@/lib/erp/supplierCreditNoteQueries";

export const dynamic = "force-dynamic";
export const maxDuration = 540; // margen sobre el plazo compartido del extractor (480 s)

const MAX_BYTES = 15 * 1024 * 1024;
// Mismo almacenamiento y formatos que las facturas de compra y los gastos.
const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const EXT_MIME: Record<string, string> = { pdf: "application/pdf", jpg: "image/jpeg", png: "image/png", webp: "image/webp" };
/** Sólo archivos que subió esta ruta (nada de rutas arbitrarias del disco). */
const OWN_FILE = /^\/uploads\/((?:nc|ce)-[a-f0-9]{16}\.(pdf|jpg|png|webp))$/;

function uploadDir() {
  return process.env.UPLOAD_DIR || path.join(process.cwd(), "public", "uploads");
}

/**
 * Soporte de una nota crédito de proveedor (PDF o foto).
 *
 *  · `file`: lo guarda junto a las facturas de compra y devuelve su URL.
 *  · `fileUrl`: un soporte ya subido (para leerlo después).
 *  · `read=1`: además lo lee con el mismo extractor de las facturas de
 *    compra (que reconoce notas crédito) y devuelve los campos para
 *    PRELLENAR la nota, el proveedor si su NIT ya existe y las compras del
 *    proveedor cuyos números cita la nota. Nada se guarda en la nota.
 *
 * Sin llave de IA configurada responde el archivo con `aiError:
 * "ai_unavailable"` (nunca llama al proveedor de IA).
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
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
    if (file.size > MAX_BYTES || file.size === 0) return NextResponse.json({ error: "bad_size" }, { status: 400 });
    buf = Buffer.from(await file.arrayBuffer());
    ext = e;
    const dir = uploadDir();
    await mkdir(dir, { recursive: true });
    // `kind=ce`: soporte de un comprobante de egreso («Pagar a proveedor»).
    const prefix = form.get("kind") === "ce" ? "ce" : "nc";
    const name = `${prefix}-${randomBytes(8).toString("hex")}.${ext}`;
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
  if (!env.ANTHROPIC_API_KEY) return NextResponse.json({ fileUrl, aiError: "ai_unavailable" }, { status: 201 });

  try {
    const extraction = await extractPurchaseInvoice(
      ext === "pdf" ? { kind: "pdf", data: buf } : { kind: "image", data: buf, mimeType: EXT_MIME[ext]! },
    );
    if (extraction.documentType === "otro" && extraction.confidence === 0) {
      return NextResponse.json({ fileUrl, aiError: "not_a_document" }, { status: 201 });
    }
    const prefill = creditNotePrefillFromInvoice(extraction, ctx.country);
    const resolved = await resolvePrefillRefs(ctx.restaurantId, prefill.supplierTaxId, prefill.referencedInvoiceNumbers);
    return NextResponse.json({ fileUrl, prefill: { ...prefill, ...resolved }, extraction }, { status: 201 });
  } catch (err) {
    console.error("supplier_credit_note_ai_failed", {
      code: err instanceof InvoiceExtractionError ? err.code : "ai_failed",
    });
    return NextResponse.json({ fileUrl, aiError: "ai_failed" }, { status: 201 });
  }
}

export const POST = secureApi(POSTHandler);
