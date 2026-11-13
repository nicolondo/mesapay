import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { BARCODE_MAX_LENGTH, normalizeBarcode } from "@/lib/erp/barcode";
import { resolveCountScan } from "@/lib/erp/countScan";
import { secureApi } from "@/lib/secureApi";

export const dynamic = "force-dynamic";

/**
 * `?code=` → a quién pertenece un código que el conteo no encontró entre sus
 * insumos: nadie, o un insumo archivado, sin inventario, de una categoría
 * que no maneja inventario o que quedó por fuera de este conteo.
 */
async function GETHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getErpContext(["inventory"]);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const raw = new URL(req.url).searchParams.get("code") ?? "";
  const code = raw.length > BARCODE_MAX_LENGTH * 2 ? null : normalizeBarcode(raw);
  if (!code || code.length > BARCODE_MAX_LENGTH) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { id } = await params;
  const result = await resolveCountScan(ctx.restaurantId, id, code);
  if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(result);
}

export const GET = secureApi(GETHandler);
