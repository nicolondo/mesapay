import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { loadChartOfAccounts } from "@/lib/erp/ledger";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Plan de cuentas del comercio (PUC NIIF Grupo 2). Lo siembra perezosamente
 * la primera vez. Fase 1: sólo lectura.
 */
export async function GET() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const accounts = await loadChartOfAccounts(ctx.restaurantId);
  return NextResponse.json({ accounts });
}
