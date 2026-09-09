import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { loadAccountMap } from "@/lib/erp/ledger";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

const schema = z.object({
  amountCents: z.number().int().min(1).max(2_000_000_000),
  paidAt: z.string().datetime().nullable().optional(),
  /** Cuenta del PUC de donde sale la plata (caja, banco…). */
  accountCode: z.string().trim().min(4).max(10),
  note: z.string().trim().max(300).nullable().optional(),
});

class PayError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

/**
 * Registrar un abono a un gasto que quedó debiéndose. Saldo =
 * amountCents − paidCents; se rechaza un abono que lo exceda. Cuando el
 * saldo llega a 0 el gasto queda pagado (paidAt).
 *
 * `accountCode` es la cuenta de donde SALE la plata: es lo que el asiento
 * acredita, en vez del banco fijo que se usaba antes.
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

  // La cuenta debe existir en el plan del comercio: un código inventado
  // dejaría el asiento sin generar y en silencio (posting omite el asiento
  // cuya cuenta no encuentra).
  const accounts = await loadAccountMap(ctx.restaurantId);
  if (!accounts.get(b.accountCode)) {
    return NextResponse.json({ error: "account_not_found" }, { status: 400 });
  }

  try {
    const result = await db.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({
        where: { id },
        select: {
          restaurantId: true,
          amountCents: true,
          paidCents: true,
          recurring: true,
        },
      });
      if (!expense || expense.restaurantId !== ctx.restaurantId) {
        throw new PayError("not_found", 404);
      }
      // Las plantillas no son un gasto real, no tienen saldo que pagar.
      if (expense.recurring) throw new PayError("wrong_status", 409);

      const outstanding = expense.amountCents - expense.paidCents;
      if (b.amountCents > outstanding) {
        throw new PayError("exceeds_balance", 400);
      }

      const paidAt = b.paidAt ? new Date(b.paidAt) : new Date();
      const payment = await tx.expensePayment.create({
        data: {
          restaurantId: ctx.restaurantId,
          expenseId: id,
          amountCents: b.amountCents,
          paidAt,
          accountCode: b.accountCode,
          note: b.note || null,
          createdById: session?.user?.id ?? null,
        },
      });
      const newPaid = expense.paidCents + b.amountCents;
      const updated = await tx.expense.update({
        where: { id },
        data: {
          paidCents: newPaid,
          paidAt: newPaid >= expense.amountCents ? paidAt : null,
        },
        include: {
          supplier: { select: { id: true, name: true } },
          costCenter: { select: { id: true, name: true } },
          payments: { orderBy: { paidAt: "desc" } },
        },
      });
      return { payment, expense: updated };
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof PayError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}

export const POST = secureApi(POSTHandler);
