import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { closeDeferredItem } from "@/lib/erp/deferred";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

type Params = { params: Promise<{ id: string }> };

/**
 * Baja del diferido: deja de amortizar desde el mes siguiente; el saldo
 * queda en la cuenta puente (sin asiento de baja). 404 si no existe,
 * 409 si ya estaba dado de baja.
 */
async function POSTHandler(_req: Request, { params }: Params) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const r = await closeDeferredItem({ restaurantId: ctx.restaurantId, id });
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error },
      { status: r.error === "not_found" ? 404 : 409 },
    );
  }
  return NextResponse.json({ ok: true, closedAt: r.item.closedAt?.toISOString() ?? null });
}

export const POST = secureApi(POSTHandler);
