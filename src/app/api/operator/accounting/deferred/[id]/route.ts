import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { loadDeferredDetail } from "@/lib/erp/deferredQuery";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

type Params = { params: Promise<{ id: string }> };

/** Detalle del diferido: ítem, asiento inicial y proyección con marca por mes. */
async function GETHandler(_req: Request, { params }: Params) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const detail = await loadDeferredDetail(ctx.restaurantId, id);
  if (!detail) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(detail);
}

export const GET = secureApi(GETHandler);
