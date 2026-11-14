import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { findDuplicateDocument } from "@/lib/erp/duplicateDocuments";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

// Compras o contabilidad: la misma factura se puede registrar como compra o
// como gasto, y las dos pantallas avisan antes de guardar.
const GATE: ModuleSlug[] = ["purchasing", "accounting"];

const querySchema = z.object({
  supplierId: z.string().min(1).max(40).optional(),
  /** NIT de un proveedor que aún no existe (factura leída con IA). */
  taxId: z.string().trim().min(1).max(40).optional(),
  number: z.string().trim().min(1).max(80),
  /** El propio documento cuando se está editando. */
  excludePurchaseId: z.string().min(1).max(40).optional(),
  excludeExpenseId: z.string().min(1).max(40).optional(),
});

/**
 * GET /api/operator/supplier-documents/duplicates?supplierId=&number=
 *
 * Aviso temprano (antes de guardar) de que esa factura del proveedor ya
 * está registrada como compra o como gasto: `{ duplicate }` con el
 * documento existente, o `{ duplicate: null }`. Sólo lectura; al guardar,
 * cada ruta vuelve a revisar bajo candado (esto no reemplaza ese bloqueo).
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const q = parsed.data;
  const exclude = q.excludePurchaseId
    ? { kind: "purchase" as const, id: q.excludePurchaseId }
    : q.excludeExpenseId
      ? { kind: "expense" as const, id: q.excludeExpenseId }
      : undefined;
  const finding = await findDuplicateDocument(db, {
    restaurantId: ctx.restaurantId,
    supplierId: q.supplierId ?? null,
    supplierTaxId: q.taxId ?? null,
    number: q.number,
    exclude,
  });
  return NextResponse.json({ duplicate: finding?.existing ?? null });
}

export const GET = secureApi(GETHandler);
