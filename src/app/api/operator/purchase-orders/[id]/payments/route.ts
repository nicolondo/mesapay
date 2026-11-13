import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { loadAccountMap } from "@/lib/erp/ledger";
import { isMoneyAccountCode } from "@/lib/erp/paymentAccounts";
import { PURCHASE_LINE_AMOUNTS_SELECT, purchaseOrderTotals } from "@/lib/erp/purchaseTax";
import { SupplierCreditError } from "@/lib/erp/supplierCreditNoteService";
import { createSupplierPayment } from "@/lib/erp/supplierPaymentService";
import { bogotaBusinessDateIso } from "@/lib/bogota";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];


const schema = z.object({
  amountCents: z.number().int().min(1).max(2_000_000_000),
  paidAt: z.string().datetime().nullable().optional(),
  /** Cuenta del PUC de donde SALE la plata (caja, banco, pasarela). */
  accountCode: z.string().trim().min(4).max(10),
  // Texto libre histórico; el cliente ya no lo manda, se conserva por
  // compatibilidad con integraciones viejas.
  method: z.string().trim().max(40).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

/**
 * Registrar un abono (pago parcial o total) de una OC recibida (F3). El
 * total bruto de la OC = Σ bruto de los ítems recibidos (neto + IVA). El
 * saldo = total − paidCents; se rechaza un abono que exceda el saldo.
 * Cuando el saldo llega a 0, la OC queda pagada (paidAt).
 *
 * `accountCode` dice de qué cuenta sale la plata (caja, banco, pasarela): es
 * la que el asiento de pagos a proveedores acredita contra la CxP (ver
 * erp/posting.ts, bloque 2b).
 */
async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  const session = await auth();

  // La cuenta debe existir en el plan del comercio y ser de dinero: un
  // código inexistente dejaría el asiento sin generar en silencio (posting
  // omite el asiento cuya cuenta no encuentra), y una que no es de
  // caja/banco/pasarela no puede ser el origen de un pago.
  const accounts = await loadAccountMap(ctx.restaurantId);
  if (!accounts.get(b.accountCode) || !isMoneyAccountCode(b.accountCode)) {
    return NextResponse.json({ error: "account_invalid" }, { status: 400 });
  }

  // Un abono desde la compra es un comprobante de egreso de UNA factura
  // (misma lógica, consecutivo y asiento que «Pagar a proveedor»), sin
  // anticipo: no puede pasar el saldo.
  const po = await db.purchaseOrder.findUnique({
    where: { id },
    select: { restaurantId: true, status: true, supplierId: true },
  });
  if (!po || po.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (po.status !== "received" && po.status !== "partially_received") {
    return NextResponse.json({ error: "wrong_status" }, { status: 409 });
  }
  const paidAt = b.paidAt ? new Date(b.paidAt) : new Date();
  try {
    const voucher = await createSupplierPayment(
      ctx.restaurantId,
      {
        supplierId: po.supplierId,
        date: bogotaBusinessDateIso(paidAt),
        accountCode: b.accountCode,
        method: b.method || null,
        note: b.note || null,
        amountCents: b.amountCents,
        docs: [{ kind: "purchase", id }],
        credits: [],
      },
      session?.user?.id ?? null,
    );
    const [payment, order] = await Promise.all([
      db.purchasePayment.findFirstOrThrow({
        where: { supplierPaymentId: voucher.id, purchaseOrderId: id },
        include: { createdBy: { select: { id: true, name: true } } },
      }),
      db.purchaseOrder.findUniqueOrThrow({
        where: { id },
        include: { items: { select: PURCHASE_LINE_AMOUNTS_SELECT } },
      }),
    ]);
    const grossTotal = purchaseOrderTotals(order, "received").totalCents;
    return NextResponse.json(
      {
        payment,
        order,
        voucher: { id: voucher.id, number: voucher.number },
        totalCents: grossTotal,
        paidCents: order.paidCents,
        outstandingCents: grossTotal - order.paidCents,
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof SupplierCreditError) {
      // Compatibilidad con la hoja de la compra: los mismos códigos de antes.
      const code = err.code === "plan_changed" ? "exceeds_balance" : err.code;
      return NextResponse.json({ error: code }, { status: code === "exceeds_balance" ? 400 : err.status });
    }
    throw err;
  }
}

export const POST = secureApi(POSTHandler);
