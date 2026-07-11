import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import {
  extractInventoryImport,
  type InventoryImportExtraction,
} from "@/lib/anthropic";
import { sheetToText } from "@/lib/erp/sheetImport";
import {
  matchInventory,
  normalizeInventoryExtraction,
} from "@/lib/erp/inventoryImport";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // catálogos grandes = varias pasadas de IA

const CHUNK_ROWS = 120;
const CHUNK_CONCURRENCY = 3;

type ImportSource =
  | { kind: "pdf"; data: Buffer }
  | { kind: "image"; data: Buffer; mimeType: string }
  | { kind: "text"; text: string };

/**
 * Para planillas GRANDES: parte el texto en lotes (repitiendo el
 * encabezado en cada uno) y corre la IA por lote con concurrencia
 * limitada, uniendo las filas. Un catálogo de 700 ítems no cabe en una
 * sola respuesta (el JSON se trunca y se pierde todo). Foto/PDF: una pasada.
 */
async function extractChunked(
  source: ImportSource,
  instructions: string,
): Promise<InventoryImportExtraction> {
  if (source.kind !== "text") return extractInventoryImport(source, instructions);
  const lines = source.text.split("\n");
  if (lines.length <= CHUNK_ROWS + 5) {
    return extractInventoryImport(source, instructions);
  }
  const header = lines[0];
  const data = lines.slice(1).filter((l) => l.replace(/\t/g, "").trim() !== "");
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += CHUNK_ROWS) {
    chunks.push([header, ...data.slice(i, i + CHUNK_ROWS)].join("\n"));
  }
  const results: InventoryImportExtraction[] = [];
  for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
    const wave = chunks.slice(i, i + CHUNK_CONCURRENCY);
    results.push(
      ...(await Promise.all(
        wave.map((c) => extractInventoryImport({ kind: "text", text: c }, instructions)),
      )),
    );
  }
  return {
    currency: results.find((r) => r.currency !== "unknown")?.currency ?? "unknown",
    rows: results.flatMap((r) => r.rows),
    notes: results.map((r) => r.notes).filter(Boolean).join(" "),
  };
}

const GATE: ModuleSlug[] = ["inventory"];
const MAX_BYTES = 15 * 1024 * 1024;

type Kind = "pdf" | "image" | "csv" | "xlsx";

function classify(file: File): { kind: Kind; mimeType: string } | null {
  const type = file.type;
  const name = file.name.toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) {
    return { kind: "pdf", mimeType: "application/pdf" };
  }
  if (name.endsWith(".xlsx") || type.includes("spreadsheetml")) {
    return { kind: "xlsx", mimeType: type };
  }
  if (
    name.endsWith(".csv") ||
    type === "text/csv" ||
    type === "application/vnd.ms-excel"
  ) {
    return { kind: "csv", mimeType: "text/csv" };
  }
  if (type.startsWith("image/") || /\.(jpe?g|png|webp)$/.test(name)) {
    const mimeType = type.startsWith("image/")
      ? type
      : name.endsWith(".png")
        ? "image/png"
        : name.endsWith(".webp")
          ? "image/webp"
          : "image/jpeg";
    return { kind: "image", mimeType };
  }
  return null;
}

/** Contexto de matching del comercio (insumos + categorías existentes). */
async function loadContext(restaurantId: string) {
  const ingredients = await db.ingredient.findMany({
    where: { restaurantId, active: true },
    select: { id: true, name: true, category: true },
  });
  const categories = [
    ...new Set(
      ingredients.map((i) => i.category?.trim()).filter((c): c is string => !!c),
    ),
  ].sort();
  return {
    ingredients: ingredients.map((i) => ({ id: i.id, name: i.name })),
    categories,
  };
}

/**
 * Sube un archivo (foto/PDF o Excel/CSV) con el catálogo de insumos, lo
 * lee con IA y devuelve las filas emparejadas con el catálogo para
 * revisar. NADA se persiste — el archivo no se guarda; reintentar =
 * re-procesar con otras instrucciones (el cliente conserva el archivo).
 */
export async function POST(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const instructions = String(form?.get("instructions") ?? "");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "no_file" }, { status: 400 });
  }
  const cls = classify(file);
  if (!cls) {
    return NextResponse.json({ error: "bad_format" }, { status: 400 });
  }
  if (file.size > MAX_BYTES || file.size === 0) {
    return NextResponse.json({ error: "bad_size" }, { status: 400 });
  }
  const buf = Buffer.from(await file.arrayBuffer());

  let source: ImportSource;
  if (cls.kind === "pdf") {
    source = { kind: "pdf", data: buf };
  } else if (cls.kind === "image") {
    source = { kind: "image", data: buf, mimeType: cls.mimeType };
  } else if (cls.kind === "csv") {
    source = { kind: "text", text: buf.toString("utf8") };
  } else {
    // xlsx → texto tabulado con el lector propio (jszip + xmldom).
    const text = await sheetToText(buf).catch(() => "");
    if (!text.trim()) {
      return NextResponse.json({ error: "bad_sheet" }, { status: 400 });
    }
    source = { kind: "text", text };
  }

  const raw = await extractChunked(source, instructions);
  const extraction = normalizeInventoryExtraction(raw);
  const matchCtx = await loadContext(ctx.restaurantId);
  const match = matchInventory(extraction, matchCtx);

  return NextResponse.json({
    currency: extraction.currency,
    notes: extraction.notes ?? "",
    match,
    categories: matchCtx.categories,
  });
}
