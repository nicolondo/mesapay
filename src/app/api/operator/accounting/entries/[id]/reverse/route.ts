import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { reverseEntry } from "@/lib/erp/journalManual";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Reversa un comprobante: crea el asiento inverso (manual) y marca el
 * original como anulado. Aplica a cualquier origen con el mes cerrado y a
 * manuales con el mes abierto. 409 si ya está anulado, si es una reversa o
 * si es un automático de mes abierto (ese se corrige regenerando).
 */
async function POSTHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const r = await reverseEntry({
    restaurantId: ctx.restaurantId,
    entryId: id,
    actorId: ctx.userId,
  });
  if (!r.ok) {
    const status = r.error === "not_found" ? 404 : r.error === "too_few_lines" ? 400 : 409;
    return NextResponse.json({ error: r.error }, { status });
  }
  return NextResponse.json({ ok: true, entry: r.entry }, { status: 201 });
}

export const POST = secureApi(POSTHandler);
