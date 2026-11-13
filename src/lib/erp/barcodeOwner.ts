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
