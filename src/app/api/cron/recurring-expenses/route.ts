import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules";
import { materializeRecurring, monthRange, recurringCopyDate } from "@/lib/erp/accounting";
import { templateCopyTaxes } from "@/lib/erp/expenseShared";
import { numberPendingExpenses } from "@/lib/erp/expenseNumber";
import { uvtCentsForDate } from "@/lib/erp/expenseTax";
import { UVT_DEFAULT_CENTS } from "@/lib/erp/retencionesCore";

export const dynamic = "force-dynamic";

/**
 * Cron diario de gastos recurrentes (ERP B2): materializa cada plantilla
 * (Expense.recurring + recurringDay) como gasto normal del mes cuando
 * llega su día (o el primer día que corra después, dentro del mes). La copia
 * hereda categoría, descripción, monto, proveedor, cuenta del PUC, centro
 * de costos y los impuestos (base, IVA, INC, tipo de documento). Las
 * retenciones se RECALCULAN con el umbral UVT del año de la copia y la
 * tarifa vigente de su concepto (ver `templateCopyTaxes`). Idempotente: la copia lleva templateId y no se re-crea si ya
 * existe una en el mes — correrlo N veces al día no duplica.
 *
 * Solo comercios con el módulo accounting activo (una plantilla creada
 * antes de apagar el módulo deja de materializarse).
 */
async function POSTHandler(req: Request) {
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
      baseCents: true,
      discountCents: true,
      ivaPct: true,
      ivaCents: true,
      ivaDeductible: true,
      incCents: true,
      payableCents: true,
      documentType: true,
      retentions: {
        orderBy: { createdAt: "asc" },
        include: {
          concept: {
            select: { id: true, kind: true, name: true, rateBps: true, ratePpm: true, base: true, thresholdUvt: true, accountCode: true, active: true },
          },
        },
      },
      supplierId: true,
      accountCode: true,
      costCenterId: true,
      recurringDay: true,
      createdAt: true,
      restaurant: { select: { enabledModules: true, accountingConfig: { select: { uvtCents: true } } } },
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
      eligible.map((t) => ({ id: t.id, recurringDay: t.recurringDay!, createdAt: t.createdAt })),
      copiedIds,
      today,
    ),
  );

  let created = 0;
  for (const t of eligible) {
    if (!dueIds.has(t.id)) continue;
    // Fecha contable = el día de la plantilla en este mes (aunque el cron
    // lo cree días después).
    const date = recurringCopyDate(today, t.recurringDay!);
    const uvt = uvtCentsForDate(date, t.restaurant.accountingConfig?.uvtCents ?? UVT_DEFAULT_CENTS);
    const taxes = templateCopyTaxes(t, uvt);
    // La copia es un gasto: nace con su consecutivo, en la misma transacción.
    await db.$transaction(async (tx) => {
      await tx.expense.create({
        data: {
          restaurantId: t.restaurantId,
          category: t.category,
          description: t.description,
          ...taxes.fields,
          documentType: t.documentType ?? "none",
          date,
          supplierId: t.supplierId,
          // Sin esto la copia caía en la cuenta que adivina la categoría y
          // sin centro de costos, aunque la plantilla los tuviera fijados.
          accountCode: t.accountCode,
          costCenterId: t.costCenterId,
          templateId: t.id,
          ...(taxes.retentions.length > 0 ? { retentions: { create: taxes.retentions } } : {}),
        },
      });
      await numberPendingExpenses(tx, t.restaurantId);
    });
    created++;
  }

  return NextResponse.json({
    templates: templates.length,
    eligible: eligible.length,
    created,
  });
}

export const POST = secureApi(POSTHandler);
