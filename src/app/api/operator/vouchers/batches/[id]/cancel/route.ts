import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";
import { cancelVoucherBatch } from "@/lib/vouchers/issue";

export const dynamic = "force-dynamic";

/**
 * Cancela un lote entero (todos sus bonos + el link de pago pendiente).
 * Sólo sin uso y, en prepago, sólo sin pagar. El lote de OTRO comercio
 * responde 404, no 403: no se revela que existe.
 */
const GATE: ModuleSlug[] = ["vouchers"];

const STATUS: Record<string, number> = {
  not_found: 404,
  used: 409,
  paid: 409,
  already_cancelled: 409,
};

async function POSTHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const result = await cancelVoucherBatch({ restaurantId: ctx.restaurantId, batchId: id });
  if (result !== "ok") {
    return NextResponse.json({ error: result }, { status: STATUS[result] ?? 400 });
  }
  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
