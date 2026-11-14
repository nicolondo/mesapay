// A quién pertenece un código de barras ya registrado — para que el error
// «ese código ya está en otro insumo» diga CUÁL y si está archivado (un
// insumo archivado no sale en el conteo ni en la lista, y sin ese dato el
// aviso era un callejón sin salida).
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export type BarcodeOwner = { id: string; name: string; active: boolean };

export async function findBarcodeOwner(restaurantId: string, barcode: string): Promise<BarcodeOwner | null> {
  const row = await db.ingredientBarcode.findUnique({
    where: { restaurantId_barcode: { restaurantId, barcode } },
    select: { ingredient: { select: { id: true, name: true, active: true } } },
  });
  return row?.ingredient ?? null;
}

/** 409 `barcode_taken` con el insumo que tiene el código (o null si ya no está). */
export async function barcodeTakenResponse(restaurantId: string, barcode: string): Promise<NextResponse> {
  const owner = await findBarcodeOwner(restaurantId, barcode).catch(() => null);
  return NextResponse.json({ error: "barcode_taken", owner }, { status: 409 });
}

/** Ficha mínima del dueño de un código, para explicar un escaneo en el conteo. */
export type BarcodeOwnerDetail = BarcodeOwner & {
  trackInventory: boolean;
  category: string | null;
  barcode: string | null;
  barcodes: { barcode: string }[];
};

/**
 * El mismo registro canónico (`IngredientBarcode`, único por comercio) que
 * usa el alta de códigos, con lo que el conteo necesita para decir por qué
 * ese insumo no aparece: archivado, sin inventario o de otra categoría.
 */
export async function findBarcodeOwnerDetail(restaurantId: string, barcode: string): Promise<BarcodeOwnerDetail | null> {
  const row = await db.ingredientBarcode.findUnique({
    where: { restaurantId_barcode: { restaurantId, barcode } },
    select: {
      ingredient: {
        select: {
          id: true, name: true, active: true, trackInventory: true, category: true, barcode: true,
          barcodes: { where: { restaurantId }, select: { barcode: true }, orderBy: { barcode: "asc" } },
        },
      },
    },
  });
  return row?.ingredient ?? null;
}
