import { Prisma } from "@prisma/client";
import { barcodeTakenResponse } from "@/lib/erp/barcodeOwner";
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
// Corregir un código: `newBarcode` cambia su valor en el mismo insumo y
// `moveTo` se lo pasa a otro insumo. Exactamente una de las dos.
const patchSchema = z.object({
  barcode: z.string().max(BARCODE_MAX_LENGTH),
  newBarcode: z.string().max(BARCODE_MAX_LENGTH).optional(),
  moveTo: z.string().min(1).max(64).optional(),
}).strict().refine((body) => (body.newBarcode === undefined) !== (body.moveTo === undefined));

/** Aborta la transacción: lo ya escrito (p. ej. soltar el código) se deshace. */
class BarcodeConflict extends Error {
  constructor(public code: "operation_conflict" | "barcode_taken") { super(code); }
}

const registrySelect = (restaurantId: string) => ({
  id: true, barcode: true,
  barcodes: { where: { restaurantId }, select: { barcode: true }, orderBy: { barcode: "asc" as const } },
});

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

  const detached = await detachBarcode(tx, restaurantId, current, barcode);
  if ("error" in detached) return detached;

  const ingredient = await tx.ingredient.findUniqueOrThrow({
    where: { id, restaurantId },
    select: {
      id: true, barcode: true,
      barcodes: { where: { restaurantId }, select: { barcode: true }, orderBy: { barcode: "asc" } },
    },
  });
  return { ingredient, name: current.name, promoted: detached.wasPrimary ? ingredient.barcode : undefined };
}

/**
 * Suelta el código del insumo (lo comparten quitar y mover). Si era el
 * principal asciende el más antiguo de los que quedan; el trigger borra la
 * fila del principal viejo y conserva la del que asciende.
 */
async function detachBarcode(
  tx: Prisma.TransactionClient, restaurantId: string,
  current: { id: string; barcode: string | null }, barcode: string,
): Promise<{ error: "barcode_not_found"; status: 404 } | { error: "operation_conflict"; status: 409 } | { wasPrimary: boolean }> {
  const id = current.id;
  const owner = await tx.ingredientBarcode.findUnique({
    where: { restaurantId_barcode: { restaurantId, barcode } },
    select: { ingredientId: true },
  });
  const isPrimary = current.barcode === barcode;
  if (!isPrimary && owner?.ingredientId !== id) return { error: "barcode_not_found", status: 404 };

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
    if (updated.count !== 1) return { error: "operation_conflict", status: 409 };
  } else {
    await tx.ingredientBarcode.deleteMany({ where: { restaurantId, ingredientId: id, barcode } });
  }
  return { wasPrimary: isPrimary };
}

/**
 * «Editar» un código: le cambia el valor en el MISMO insumo (se digitó o se
 * escaneó mal). Conserva su lugar —si era el principal, lo sigue siendo— y
 * exige lo mismo que un alta: insumo activo, inventariable y código libre.
 */
async function replaceIngredientBarcode(tx: Prisma.TransactionClient, restaurantId: string, id: string, barcode: string, next: string) {
  await lockStock(tx, restaurantId);
  const current = await tx.ingredient.findFirst({
    where: { id, restaurantId },
    select: { id: true, name: true, barcode: true, active: true, trackInventory: true },
  });
  if (!current) return { error: "not_found", status: 404 } as const;
  const owner = await tx.ingredientBarcode.findUnique({
    where: { restaurantId_barcode: { restaurantId, barcode } },
    select: { ingredientId: true },
  });
  const isPrimary = current.barcode === barcode;
  if (!isPrimary && owner?.ingredientId !== id) return { error: "barcode_not_found", status: 404 } as const;

  if (next !== barcode) {
    if (!current.active) return { error: "ingredient_inactive", status: 409 } as const;
    if (!current.trackInventory) return { error: "ingredient_not_tracked", status: 409 } as const;
    const nextOwner = await tx.ingredientBarcode.findUnique({
      where: { restaurantId_barcode: { restaurantId, barcode: next } },
      select: { ingredientId: true },
    });
    if (nextOwner && nextOwner.ingredientId !== id) return { error: "barcode_taken", status: 409 } as const;
    if (isPrimary) {
      // El trigger del principal borra la fila del valor viejo y asegura la del nuevo.
      const updated = await tx.ingredient.updateMany({ where: { id, restaurantId, barcode }, data: { barcode: next } });
      if (updated.count !== 1) throw new BarcodeConflict("operation_conflict");
    } else if (nextOwner) {
      // El valor nuevo ya era otro código de este insumo: solo sobra el viejo.
      await tx.ingredientBarcode.deleteMany({ where: { restaurantId, ingredientId: id, barcode } });
    } else {
      const updated = await tx.ingredientBarcode.updateMany({ where: { restaurantId, ingredientId: id, barcode }, data: { barcode: next } });
      if (updated.count !== 1) throw new BarcodeConflict("operation_conflict");
    }
  }
  const ingredient = await tx.ingredient.findUniqueOrThrow({ where: { id, restaurantId }, select: registrySelect(restaurantId) });
  return { ingredient, name: current.name, changed: next !== barcode };
}

/**
 * Pasa un código de un insumo a otro en una sola transacción: lo suelta del
 * dueño actual (aunque esté archivado o ya no lleve inventario: liberar un
 * código nunca daña nada) y lo deja en el destino, que sí debe estar activo
 * y llevar inventario. El código nunca queda en dos insumos ni en ninguno.
 */
async function moveIngredientBarcode(tx: Prisma.TransactionClient, restaurantId: string, sourceId: string, barcode: string, targetId: string) {
  await lockStock(tx, restaurantId);
  const source = await tx.ingredient.findFirst({
    where: { id: sourceId, restaurantId },
    select: { id: true, name: true, barcode: true },
  });
  if (!source) return { error: "not_found", status: 404 } as const;
  const target = await tx.ingredient.findFirst({
    where: { id: targetId, restaurantId },
    select: { id: true, name: true, barcode: true, active: true, trackInventory: true },
  });
  if (!target) return { error: "target_not_found", status: 404 } as const;
  if (!target.active) return { error: "ingredient_inactive", status: 409 } as const;
  if (!target.trackInventory) return { error: "ingredient_not_tracked", status: 409 } as const;

  const detached = await detachBarcode(tx, restaurantId, source, barcode);
  if ("error" in detached) return detached;

  if (target.barcode === null) {
    const updated = await tx.ingredient.updateMany({
      where: { id: targetId, restaurantId, barcode: null, active: true, trackInventory: true },
      data: { barcode },
    });
    if (updated.count !== 1) throw new BarcodeConflict("operation_conflict");
  } else {
    await tx.ingredientBarcode.create({ data: { restaurantId, ingredientId: targetId, barcode } });
  }

  const ingredient = await tx.ingredient.findUniqueOrThrow({ where: { id: sourceId, restaurantId }, select: registrySelect(restaurantId) });
  const moved = await tx.ingredient.findUniqueOrThrow({ where: { id: targetId, restaurantId }, select: registrySelect(restaurantId) });
  return {
    ingredient, target: moved, sourceName: source.name, targetName: target.name,
    promoted: detached.wasPrimary ? ingredient.barcode : undefined,
  };
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
    if ("error" in result) {
      if (result.error === "barcode_taken") return barcodeTakenResponse(ctx.restaurantId, barcode);
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
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
      return barcodeTakenResponse(ctx.restaurantId, barcode);
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

async function PATCHHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(["inventory"]);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const barcode = normalizeBarcode(parsed.data.barcode);
  if (!barcode) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { id } = await params;
  const { moveTo } = parsed.data;
  const next = parsed.data.newBarcode === undefined ? undefined : normalizeBarcode(parsed.data.newBarcode);
  if (next === null || moveTo === id) return NextResponse.json({ error: "invalid" }, { status: 400 });

  try {
    if (moveTo !== undefined) {
      const result = await db.$transaction((tx) => moveIngredientBarcode(tx, ctx.restaurantId, id, barcode, moveTo));
      if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
      await recordAuditEvent({
        kind: "ingredient.barcode.move", restaurantId: ctx.restaurantId,
        target: { type: "ingredient", id: moveTo }, summary: `${result.sourceName} → ${result.targetName}`,
        diff: {
          before: { barcode, ingredientId: id, ingredient: result.sourceName },
          after: {
            barcode, ingredientId: moveTo, ingredient: result.targetName,
            ...(result.promoted !== undefined ? { sourcePrimary: result.promoted } : {}),
          },
        },
      });
      return NextResponse.json({ ingredient: result.ingredient, target: result.target });
    }
    const replacement = next as string;
    const result = await db.$transaction((tx) => replaceIngredientBarcode(tx, ctx.restaurantId, id, barcode, replacement));
    if ("error" in result) {
      if (result.error === "barcode_taken") return barcodeTakenResponse(ctx.restaurantId, replacement);
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    if (result.changed) {
      await recordAuditEvent({
        kind: "ingredient.barcode.replace", restaurantId: ctx.restaurantId,
        target: { type: "ingredient", id }, summary: result.name,
        diff: { before: { barcode }, after: { barcode: replacement } },
      });
    }
    return NextResponse.json({ ingredient: result.ingredient });
  } catch (error) {
    if (error instanceof BarcodeConflict) return NextResponse.json({ error: error.code }, { status: 409 });
    // El índice único también cubre a quien escriba el principal por fuera del lock.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return barcodeTakenResponse(ctx.restaurantId, next ?? barcode);
    }
    throw error;
  }
}

export const POST = secureApi(POSTHandler);

export const PATCH = secureApi(PATCHHandler);

export const DELETE = secureApi(DELETEHandler);
