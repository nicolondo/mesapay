import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules";
import { materializeRecurring, monthRange } from "@/lib/erp/accounting";

export const dynamic = "force-dynamic";

/**
 * Cron diario de gastos recurrentes (ERP B2): materializa cada plantilla
 * (Expense.recurring + recurringDay) como gasto normal del mes cuando
 * llega su día. Idempotente: la copia lleva templateId y no se re-crea
 * si ya existe una en el mes — correrlo N veces al día no duplica.
 *
 * Solo comercios con el módulo accounting activo (una plantilla creada
 * antes de apagar el módulo deja de materializarse).
 */
export async function POST(req: Request) {
  const secret = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET ?? "";
  if (!expected || secret !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const today = new Date();
  const month = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}`;
  const range = monthRange(month)!;

  const templates = await db.expense.findMany({
    where: { recurring: true, recurringDay: { not: null } },
    select: {
      id: true,
      restaurantId: true,
      category: true,
      description: true,
      amountCents: true,
      supplierId: true,
      recurringDay: true,
      restaurant: { select: { enabledModules: true } },
      copies: {
        where: { date: { gte: range.from, lt: range.to } },
        select: { id: true },
        take: 1,
      },
    },
  });

  const eligible = templates.filter((t) =>
    isModuleEnabled(t.restaurant.enabledModules, "accounting"),
  );
  const copiedIds = new Set(
    eligible.filter((t) => t.copies.length > 0).map((t) => t.id),
  );
  const dueIds = new Set(
    materializeRecurring(
      eligible.map((t) => ({ id: t.id, recurringDay: t.recurringDay! })),
      copiedIds,
      today,
    ),
  );

  let created = 0;
  for (const t of eligible) {
    if (!dueIds.has(t.id)) continue;
    await db.expense.create({
      data: {
        restaurantId: t.restaurantId,
        category: t.category,
        description: t.description,
        amountCents: t.amountCents,
        // Fecha contable = hoy (el día de la plantilla, por definición).
        date: today,
        supplierId: t.supplierId,
        templateId: t.id,
      },
    });
    created++;
  }

  return NextResponse.json({
    templates: templates.length,
    eligible: eligible.length,
    created,
  });
}
