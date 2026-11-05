import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { BARCODE_MAX_LENGTH, normalizeBarcode } from "@/lib/erp/barcode";
import { lockStock } from "@/lib/orderLock";
import { recordAuditEvent } from "@/lib/auditLog";
import { secureApi } from "@/lib/secureApi";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ barcode: z.string().max(BARCODE_MAX_LENGTH) }).strict();

async function addIngredientBarcode(tx: Prisma.TransactionClient, restaurantId: string, id: string, barcode: string) {
  await lockStock(tx, restaurantId);
  const current = await tx.ingredient.findFirst({
    where: { id, restaurantId },
    select: { id: true, name: true, barcode: true, active: true, trackInventory: true },
  });
  if (!current) return { error: "not_found", status: 404 } as const;
  if (!current.active) return { error: "ingredient_inactive", status: 409 } as const;
  if (!current.trackInventory) return { error: "ingredient_not_tracked", status: 409 } as const;

  const owner = await tx.ingredientBarcode.findUnique({
    where: { restaurantId_barcode: { restaurantId, barcode } },
    select: { ingredientId: true },
  });
  if (owner && owner.ingredientId !== id) return { error: "barcode_taken", status: 409 } as const;

  if (current.barcode === null) {
    // The primary remains compatible with older clients. Its database trigger
    // also reserves the canonical code, including promotion of an existing alias.
    const updated = await tx.ingredient.updateMany({
      where: { id, restaurantId, barcode: null, active: true, trackInventory: true },
      data: { barcode },
    });
    if (updated.count !== 1) return { error: "operation_conflict", status: 409 } as const;
  } else if (!owner) {
    await tx.ingredientBarcode.create({ data: { restaurantId, ingredientId: id, barcode } });
  }

  const ingredient = await tx.ingredient.findUniqueOrThrow({
    where: { id, restaurantId },
    select: {
      id: true, barcode: true,
      barcodes: { where: { restaurantId }, select: { barcode: true }, orderBy: { barcode: "asc" } },
    },
  });
  return { ingredient, added: !owner, name: current.name };
}

/**
 * Quita un código del insumo. Si era el principal (`Ingredient.barcode`, el
 * campo que leen los clientes viejos), lo reemplaza el siguiente código del
 * registro: el trigger `sync_ingredient_primary_barcode` borra la fila del
 * principal viejo y conserva la del que asciende. Se permite también en
 * insumos archivados o no inventariables: liberar un código nunca daña el
 * conteo y deja reasignarlo a otro insumo.
 */
async function removeIngredientBarcode(tx: Prisma.TransactionClient, restaurantId: string, id: string, barcode: string) {
  await lockStock(tx, restaurantId);
  const current = await tx.ingredient.findFirst({
    where: { id, restaurantId },
    select: { id: true, name: true, barcode: true },
  });
  if (!current) return { error: "not_found", status: 404 } as const;

  const owner = await tx.ingredientBarcode.findUnique({
    where: { restaurantId_barcode: { restaurantId, barcode } },
    select: { ingredientId: true },
  });
  const isPrimary = current.barcode === barcode;
  if (!isPrimary && owner?.ingredientId !== id) return { error: "barcode_not_found", status: 404 } as const;

  if (isPrimary) {
    const next = await tx.ingredientBarcode.findFirst({
      where: { restaurantId, ingredientId: id, barcode: { not: barcode } },
      orderBy: [{ createdAt: "asc" }, { barcode: "asc" }],
      select: { barcode: true },
    });
    const updated = await tx.ingredient.updateMany({
      where: { id, restaurantId, barcode },
      data: { barcode: next?.barcode ?? null },
    });
    if (updated.count !== 1) return { error: "operation_conflict", status: 409 } as const;
  } else {
    await tx.ingredientBarcode.deleteMany({ where: { restaurantId, ingredientId: id, barcode } });
  }

  const ingredient = await tx.ingredient.findUniqueOrThrow({
    where: { id, restaurantId },
    select: {
      id: true, barcode: true,
      barcodes: { where: { restaurantId }, select: { barcode: true }, orderBy: { barcode: "asc" } },
    },
  });
  return { ingredient, name: current.name, promoted: isPrimary ? ingredient.barcode : undefined };
}

async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(["inventory"]);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const barcode = normalizeBarcode(parsed.data.barcode);
  if (!barcode) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { id } = await params;

  try {
    const result = await db.$transaction((tx) => addIngredientBarcode(tx, ctx.restaurantId, id, barcode));
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
    if (result.added) {
      await recordAuditEvent({
        kind: "ingredient.barcode.add", restaurantId: ctx.restaurantId,
        target: { type: "ingredient", id }, summary: result.name,
        diff: { before: { barcode: null }, after: { barcode } },
      });
    }
    return NextResponse.json({ ingredient: result.ingredient });
  } catch (error) {
    // The canonical unique index also covers older writers of the primary.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json({ error: "barcode_taken" }, { status: 409 });
    }
    throw error;
  }
}

async function DELETEHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(["inventory"]);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const barcode = normalizeBarcode(parsed.data.barcode);
  if (!barcode) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { id } = await params;

  const result = await db.$transaction((tx) => removeIngredientBarcode(tx, ctx.restaurantId, id, barcode));
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
  await recordAuditEvent({
    kind: "ingredient.barcode.remove", restaurantId: ctx.restaurantId,
    target: { type: "ingredient", id }, summary: result.name,
    diff: {
      before: { barcode },
      after: { barcode: null, ...(result.promoted !== undefined ? { primary: result.promoted } : {}) },
    },
  });
  return NextResponse.json({ ingredient: result.ingredient });
}

export const POST = secureApi(POSTHandler);

export const DELETE = secureApi(DELETEHandler);
