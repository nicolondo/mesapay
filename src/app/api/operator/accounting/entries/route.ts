import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { createManualEntry } from "@/lib/erp/journalManual";
import { manualEntryBodySchema } from "@/lib/erp/journalManualSchema";
import { listEntries } from "@/lib/erp/journalQuery";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Libro de comprobantes: todos los orígenes, con filtros de fecha y búsqueda
 * (`q` numérico → número de comprobante exacto; texto → descripción) y
 * paginación por cursor. `limit` ≤ 200.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const limitRaw = Number(searchParams.get("limit"));
  const result = await listEntries(ctx.restaurantId, {
    desde: searchParams.get("desde"),
    hasta: searchParams.get("hasta"),
    q: searchParams.get("q"),
    cursor: searchParams.get("cursor"),
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : null,
  });
  return NextResponse.json(result);
}

/** Crea un comprobante manual (asiento libre). 400 con el código de validación. */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = manualEntryBodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const r = await createManualEntry({
    restaurantId: ctx.restaurantId,
    actorId: ctx.userId,
    input: parsed.data,
  });
  if (!r.ok) {
    return NextResponse.json(
      { error: r.error, ...(r.line != null && { line: r.line }) },
      { status: r.error === "period_closed" ? 409 : 400 },
    );
  }
  return NextResponse.json({ ok: true, entry: r.entry }, { status: 201 });
}

export const GET = secureApi(GETHandler);

export const POST = secureApi(POSTHandler);
