import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma, type Ingredient } from "@prisma/client";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { BARCODE_MAX_LENGTH, normalizeBarcode } from "@/lib/erp/barcode";
import { recordAuditEvent } from "@/lib/auditLog";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

// El catálogo de insumos es la base de los tres módulos del track A:
// basta con tener UNO activo para gestionarlo.
const GATE: ModuleSlug[] = ["inventory", "purchasing", "recipes"];

const createSchema = z.object({
  trackInventory: z.boolean().default(true),
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(60).nullable().optional(),
  measureKind: z.enum(["mass", "volume", "count"]),
  sku: z.string().trim().max(60).nullable().optional(),
  // Código de barras: llega crudo del lector (puede traer Enter/espacios)
  // y se normaliza acá, nunca en el cliente — así el mismo empaque guarda
  // el mismo string venga del formulario o de una importación futura.
  barcode: z.string().max(BARCODE_MAX_LENGTH).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  referencePriceCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
});

async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const ingredients = await db.ingredient.findMany({
    where: { restaurantId: ctx.restaurantId },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    include: {
      _count: { select: { supplierItems: true } },
      barcodes: { where: { restaurantId: ctx.restaurantId }, select: { barcode: true }, orderBy: { barcode: "asc" } },
    },
  });
  return NextResponse.json({ ingredients });
}

async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  // Unicidad con error legible antes del constraint (la UI muestra
  // name_taken traducido).
  const dup = await db.ingredient.findUnique({
    where: {
      restaurantId_name: { restaurantId: ctx.restaurantId, name: b.name },
    },
    select: { id: true },
  });
  if (dup) {
    return NextResponse.json({ error: "name_taken" }, { status: 409 });
  }
  // Mismo trato para el código de barras: error legible antes de que
  // reviente el índice único (dos insumos con el mismo código harían
  // ambiguo el escaneo en el conteo).
  const barcode = normalizeBarcode(b.barcode);
  if (barcode) {
    const dupCode = await db.ingredientBarcode.findUnique({
      where: {
        restaurantId_barcode: { restaurantId: ctx.restaurantId, barcode },
      },
      select: { ingredientId: true },
    });
    if (dupCode) {
      return NextResponse.json({ error: "barcode_taken" }, { status: 409 });
    }
  }
  let ingredient: Ingredient;
  try {
    ingredient = await db.ingredient.create({
      data: {
        restaurantId: ctx.restaurantId,
        name: b.name,
        trackInventory: b.trackInventory,
        category: b.category || null,
        measureKind: b.measureKind,
        sku: b.sku || null,
        barcode,
        notes: b.notes || null,
        referencePriceCents: b.referencePriceCents ?? null,
      },
    });
  } catch (error) {
    if (barcode && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = error.meta?.target;
      const barcodeTarget = Array.isArray(target) ? target.includes("barcode") : typeof target === "string" && target.includes("barcode");
      // Trigger failures may omit the target. Query after the failed write has
      // rolled back so a concurrent additional code still produces a clear error.
      const conflictingCode = target == null && await db.ingredientBarcode.findUnique({
        where: { restaurantId_barcode: { restaurantId: ctx.restaurantId, barcode } },
        select: { ingredientId: true },
      });
      if (barcodeTarget || conflictingCode) return NextResponse.json({ error: "barcode_taken" }, { status: 409 });
    }
    throw error;
  }
  if (ingredient.referencePriceCents != null) {
    await recordAuditEvent({
      kind: "ingredient.reference_price.update",
      restaurantId: ctx.restaurantId,
      target: { type: "ingredient", id: ingredient.id },
      summary: ingredient.name,
      diff: {
        before: { referencePriceCents: null, measureKind: ingredient.measureKind },
        after: { referencePriceCents: ingredient.referencePriceCents, measureKind: ingredient.measureKind },
      },
    });
  }
  return NextResponse.json({ ingredient }, { status: 201 });
}

export const GET = secureApi(GETHandler);

export const POST = secureApi(POSTHandler);
