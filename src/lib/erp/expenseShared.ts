// Validaciones compartidas de gastos (ERP B2) — las usan las rutas de
// /api/operator/expenses (un route.ts no puede exportar helpers).
import { z } from "zod";
import { db } from "@/lib/db";

export const expenseBodySchema = z.object({
  category: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).nullable().optional(),
  amountCents: z.number().int().min(1).max(2_000_000_000),
  date: z.string().datetime(),
  supplierId: z.string().min(1).nullable().optional(),
  costCenterId: z.string().min(1).nullable().optional(),
  recurring: z.boolean().optional(),
  recurringDay: z.number().int().min(1).max(28).nullable().optional(),
  /** Cuenta del PUC a la que se carga el gasto. null = derivar de la categoría. */
  accountCode: z.string().trim().min(4).max(10).nullable().optional(),
  /** Vencimiento, si queda debiéndose. */
  dueAt: z.string().datetime().nullable().optional(),
  /**
   * Pago de contado: la cuenta de donde sale la plata. Si viene, se crea el
   * abono por el total del gasto en la misma transacción y el gasto queda
   * saldado en un solo paso.
   */
  payFromAccountCode: z.string().trim().min(4).max(10).nullable().optional(),
});

/** recurring ⇔ recurringDay van juntos. */
export function recurrenceError(b: {
  recurring: boolean;
  recurringDay?: number | null;
}): string | null {
  if (b.recurring && b.recurringDay == null) return "recurring_day_required";
  if (!b.recurring && b.recurringDay != null) return "recurring_day_forbidden";
  return null;
}

export function dateInRange(date: Date): boolean {
  const y = date.getUTCFullYear();
  return !Number.isNaN(y) && y >= 2020 && y <= 2100;
}

export async function supplierOwned(
  supplierId: string | null | undefined,
  restaurantId: string,
): Promise<boolean> {
  if (!supplierId) return true;
  const s = await db.supplier.findUnique({
    where: { id: supplierId },
    select: { restaurantId: true },
  });
  return s?.restaurantId === restaurantId;
}
