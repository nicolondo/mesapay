import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { listMoneyAccounts } from "@/lib/erp/paymentAccounts";
import { sortPayablesFifo } from "@/lib/erp/supplierCreditAllocation";
import { CREDIT_NOTE_GATE } from "@/lib/erp/supplierCreditNoteApi";
import { loadPaymentCredits } from "@/lib/erp/supplierPaymentService";
import { loadSupplierPayables } from "@/lib/erp/supplierPayables";

export const dynamic = "force-dynamic";

/**
 * Al elegir el proveedor en «Pagar a proveedor»: TODO lo pendiente (compras
 * con saldo y gastos por pagar) en orden FIFO, sus saldos a favor (notas
 * crédito y anticipos) y las cuentas de dinero.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(CREDIT_NOTE_GATE);
  if (isDenied(ctx)) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const supplierId = new URL(req.url).searchParams.get("supplierId") ?? "";
  const supplier = await db.supplier.findFirst({ where: { id: supplierId, restaurantId: ctx.restaurantId }, select: { id: true } });
  if (!supplier) return NextResponse.json({ error: "supplier_not_found" }, { status: 404 });
  const [payables, credits, accounts] = await Promise.all([
    loadSupplierPayables(db, ctx.restaurantId, supplier.id),
    loadPaymentCredits(db, ctx.restaurantId, supplier.id),
    listMoneyAccounts(ctx.restaurantId),
  ]);
  return NextResponse.json({ payables: sortPayablesFifo(payables), credits, accounts });
}

export const GET = secureApi(GETHandler);
