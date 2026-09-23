import { NextResponse } from "next/server";
import { secureApi } from "@/lib/secureApi";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { BILLING_CUSTOMER_WRITE_ROLES } from "@/lib/billingCustomers";
import { listMoneyAccounts } from "@/lib/erp/paymentAccounts";

export const dynamic = "force-dynamic";

/**
 * Cuentas de dinero (caja, bancos, pasarela) donde puede entrar un abono
 * de cliente. Misma guardia que las rutas de clientes (no depende del
 * módulo contable: listMoneyAccounts siembra el plan si hace falta).
 */
async function GETHandler() {
  const scope = await requireOperatorScope(BILLING_CUSTOMER_WRITE_ROLES);
  if (isScopeError(scope)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ accounts: await listMoneyAccounts(scope.restaurantId) });
}

export const GET = secureApi(GETHandler);
