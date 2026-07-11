import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { poTotals } from "@/lib/erp/purchaseTax";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["purchasing"];

class PayError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

const schema = z.object({
  amountCents: z.number().int().min(1).max(2_000_000_000),
  paidAt: z.string().datetime().nullable().optional(),
  method: z.string().trim().max(40).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

/**
 * Registrar un abono (pago parcial o total) de una OC recibida (F3). El
 * total bruto de la OC = Σ bruto de los ítems recibidos (neto + IVA). El
 * saldo = total − paidCents; se rechaza un abono que exceda el saldo.
 * Cuando el saldo llega a 0, la OC queda pagada (paidAt).
 */
export async function POST(
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

  try {
    const result = await db.$transaction(async (tx) => {
      const po = await tx.purchaseOrder.findUnique({
        where: { id },
        select: {
          restaurantId: true,
          status: true,
          paidCents: true,
          items: { select: { receivedCostCents: true, taxPct: true } },
        },
      });
      if (!po || po.restaurantId !== ctx.restaurantId) {
        throw new PayError("not_found", 404);
      }
      // Solo las OCs con mercancía recibida tienen CxP.
      if (po.status !== "received" && po.status !== "partially_received") {
        throw new PayError("wrong_status", 409);
      }
      const grossTotal = poTotals(
        po.items.map((i) => ({ costCents: i.receivedCostCents, taxPct: i.taxPct })),
      ).totalCents;
      const outstanding = grossTotal - po.paidCents;
      if (b.amountCents > outstanding) {
        throw new PayError("exceeds_balance", 400);
      }

      const paidAt = b.paidAt ? new Date(b.paidAt) : new Date();
      const payment = await tx.purchasePayment.create({
        data: {
          restaurantId: ctx.restaurantId,
          purchaseOrderId: id,
          amountCents: b.amountCents,
          paidAt,
          method: b.method || null,
          note: b.note || null,
          createdById: session?.user?.id ?? null,
        },
        include: { createdBy: { select: { id: true, name: true } } },
      });
      const newPaid = po.paidCents + b.amountCents;
      const order = await tx.purchaseOrder.update({
        where: { id },
        data: {
          paidCents: newPaid,
          // Pagada por completo cuando el saldo llega a 0.
          paidAt: newPaid >= grossTotal ? paidAt : null,
        },
      });
      return {
        payment,
        order,
        totalCents: grossTotal,
        paidCents: newPaid,
        outstandingCents: grossTotal - newPaid,
      };
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof PayError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}
