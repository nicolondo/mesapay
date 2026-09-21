import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { listMoneyAccounts } from "@/lib/erp/paymentAccounts";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

// Gate `purchasing` a propósito (no `accounting`): la pantalla de compras no
// debe depender del módulo contable para registrar un abono, y
// listMoneyAccounts siembra el plan de cuentas si todavía no existe.
const GATE: ModuleSlug[] = ["purchasing"];

/**
 * Cuentas de dinero (caja, bancos, pasarela) desde las que se puede pagar
 * una orden de compra. Alimenta el selector del formulario de abono.
 */
async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  return NextResponse.json({ accounts: await listMoneyAccounts(ctx.restaurantId) });
}

export const GET = secureApi(GETHandler);
