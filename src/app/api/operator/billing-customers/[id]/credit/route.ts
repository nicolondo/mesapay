import { NextResponse } from "next/server";
import { secureApi } from "@/lib/secureApi";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { BILLING_CUSTOMER_WRITE_ROLES } from "@/lib/billingCustomers";
import { loadCustomerCreditSummary } from "@/lib/customerCredit";

export const dynamic = "force-dynamic";

/**
 * Estado de cuenta de crédito de un cliente: cargos (cuentas cobradas a
 * crédito) con su saldo FIFO, abonos y deuda. Alimenta el sheet "Estado de
 * cuenta" del listado de clientes.
 */
async function GETHandler(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = await requireOperatorScope(BILLING_CUSTOMER_WRITE_ROLES);
  if (isScopeError(scope)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const summary = await loadCustomerCreditSummary(scope.restaurantId, id);
  if (!summary) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const outstandingByCharge = new Map(summary.fifo.charges.map((c) => [c.chargeId, c.outstandingCents]));
  return NextResponse.json(
    {
      customer: summary.customer,
      debtCents: summary.debtCents,
      charges: summary.charges.map((c) => ({
        id: c.id,
        date: c.date.toISOString(),
        amountCents: c.amountCents,
        tipCents: c.tipCents,
        refundedCents: c.refundedCents,
        outstandingCents: outstandingByCharge.get(c.id) ?? 0,
        orderId: c.orderId,
        orderShortCode: c.orderShortCode,
        tableLabel: c.tableLabel,
      })),
      payments: summary.payments.map((p) => ({
        id: p.id,
        date: p.date.toISOString(),
        amountCents: p.amountCents,
        accountCode: p.accountCode,
        note: p.note,
        createdByName: p.createdByName,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = secureApi(GETHandler);
