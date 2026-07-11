import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { extractInventoryImport } from "@/lib/anthropic";
import { sheetToText } from "@/lib/erp/sheetImport";
import {
  matchInventory,
  normalizeInventoryExtraction,
} from "@/lib/erp/inventoryImport";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // la extracción con IA puede tardar

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

  let source:
    | { kind: "pdf"; data: Buffer }
    | { kind: "image"; data: Buffer; mimeType: string }
    | { kind: "text"; text: string };
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

  const raw = await extractInventoryImport(source, instructions);
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
