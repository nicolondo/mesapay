import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { secureApi } from "@/lib/secureApi";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { BILLING_CUSTOMER_WRITE_ROLES } from "@/lib/billingCustomers";
import { loadCustomerCreditSummary } from "@/lib/customerCredit";
import { listMoneyAccounts } from "@/lib/erp/paymentAccounts";
import { parseEntryDate } from "@/lib/erp/journalManual";

export const dynamic = "force-dynamic";

const schema = z.object({
  amountCents: z.number().int().min(1).max(2_000_000_000),
  /** Día del abono (yyyy-mm-dd); vacío = hoy. Se guarda al mediodía UTC como el resto del ERP. */
  paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Cuenta de dinero (caja, banco, pasarela) donde entró la plata. */
  accountCode: z.string().trim().min(4).max(10),
  note: z.string().trim().max(300).nullable().optional(),
});

/**
 * Registrar un abono del cliente a su deuda por ventas a crédito. No se
 * liga a una cuenta puntual (la deuda se aplica FIFO); se rechaza un abono
 * mayor que la deuda para no crear saldos a favor. La cuenta de origen
 * tiene que ser una cuenta de dinero del plan del comercio: es la que el
 * asiento "Abonos de clientes" debita contra 130505.
 */
async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = await requireOperatorScope(BILLING_CUSTOMER_WRITE_ROLES);
  if (isScopeError(scope)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const b = parsed.data;

  const paidAt = b.paidAt ? parseEntryDate(b.paidAt) : new Date();
  if (!paidAt) return NextResponse.json({ error: "invalid_date" }, { status: 400 });

  const accounts = await listMoneyAccounts(scope.restaurantId);
  if (!accounts.some((a) => a.code === b.accountCode)) {
    return NextResponse.json({ error: "account_invalid" }, { status: 400 });
  }

  const result = await db.$transaction(async (tx) => {
    // Serializa los abonos del mismo cliente: dos cajeros a la vez no
    // pueden pasarse de la deuda entre los dos.
    await tx.$queryRaw`SELECT id FROM "BillingCustomer" WHERE id = ${id} FOR UPDATE`;
    const summary = await loadCustomerCreditSummary(scope.restaurantId, id, tx);
    if (!summary) return { error: "not_found" as const };
    if (b.amountCents > summary.debtCents) {
      return { error: "exceeds_debt" as const, debtCents: summary.debtCents };
    }
    const payment = await tx.customerCreditPayment.create({
      data: {
        restaurantId: scope.restaurantId,
        billingCustomerId: id,
        amountCents: b.amountCents,
        paidAt,
        accountCode: b.accountCode,
        note: b.note || null,
        createdById: scope.userId,
      },
    });
    return { payment, debtAfterCents: summary.debtCents - b.amountCents };
  });

  if ("error" in result) {
    if (result.error === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ error: result.error, debtCents: result.debtCents }, { status: 400 });
  }
  return NextResponse.json(
    { payment: { id: result.payment.id }, debtAfterCents: result.debtAfterCents },
    { status: 201 },
  );
}

export const POST = secureApi(POSTHandler);
