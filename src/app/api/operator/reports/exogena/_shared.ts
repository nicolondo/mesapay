import { NextResponse } from "next/server";
import { getErpContext, isDenied, type ErpContext } from "@/lib/erp/access";
import { parseAnoGravable } from "@/lib/erp/exogena/normativa";
import type { ModuleSlug } from "@/lib/modules";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Gate de las rutas de exógena: módulo `accounting` + comercio colombiano.
 * La información exógena es un régimen de la DIAN: para un comercio de otro
 * país la ruta no existe (404 `not_applicable`), igual que la pantalla.
 */
export async function exogenaContext(): Promise<ErpContext | NextResponse> {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  if (ctx.country?.trim().toUpperCase() !== "CO") {
    return NextResponse.json({ error: "not_applicable" }, { status: 404 });
  }
  return ctx;
}

export function isResponse(v: ErpContext | NextResponse): v is NextResponse {
  return v instanceof Response;
}

/** Año gravable de la query (ver `parseAnoGravable`). */
export function parseExogenaYear(raw: string | null): number | null {
  return parseAnoGravable(raw);
}
