import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { monthRange } from "@/lib/erp/accounting";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/**
 * Grupos PUC presupuestables (prefijo → lo ejecutado se lee del libro).
 * Ingresos van por naturaleza crédito (crédito − débito); el resto débito.
 */
export const BUDGET_GROUPS: Array<{ code: string; credit: boolean }> = [
  { code: "41", credit: true }, // ingresos operacionales
  { code: "51", credit: false }, // gastos de administración
  { code: "52", credit: false }, // gastos de ventas
  { code: "53", credit: false }, // no operacionales
  { code: "61", credit: false }, // costo de ventas
];

/**
 * Presupuesto del año + ejecutado del MES pedido, por grupo PUC. Lo
 * ejecutado suma las líneas del libro cuyo código arranca con el prefijo.
 */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? "";
  const range = monthRange(month);
  if (!range) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const year = Number(month.slice(0, 4));

  const [budgets, lines] = await Promise.all([
    db.budget.findMany({ where: { restaurantId: ctx.restaurantId, year } }),
    db.journalLine.findMany({
      where: {
        entry: {
          restaurantId: ctx.restaurantId,
          date: { gte: range.from, lt: range.to },
        },
      },
      select: { accountCode: true, debitCents: true, creditCents: true },
    }),
  ]);

  const byCode = new Map(budgets.map((b) => [b.accountCode, b.monthlyCents]));
  const rows = BUDGET_GROUPS.map((g) => {
    let executed = 0;
    for (const l of lines) {
      if (!l.accountCode.startsWith(g.code)) continue;
      executed += g.credit
        ? l.creditCents - l.debitCents
        : l.debitCents - l.creditCents;
    }
    return {
      accountCode: g.code,
      monthlyCents: byCode.get(g.code) ?? 0,
      executedCents: executed,
    };
  });
  return NextResponse.json({ month, year, rows });
}

const putSchema = z.object({
  year: z.number().int().min(2020).max(2100),
  rows: z
    .array(
      z.object({
        accountCode: z.string().min(2).max(6),
        monthlyCents: z.number().int().min(0).max(100_000_000_000),
      }),
    )
    .max(20),
});

/** Guarda el presupuesto mensual del año (upsert por grupo). */
export async function PUT(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const allowed = new Set(BUDGET_GROUPS.map((g) => g.code));
  for (const row of parsed.data.rows) {
    if (!allowed.has(row.accountCode)) {
      return NextResponse.json({ error: "invalid" }, { status: 400 });
    }
    await db.budget.upsert({
      where: {
        restaurantId_year_accountCode: {
          restaurantId: ctx.restaurantId,
          year: parsed.data.year,
          accountCode: row.accountCode,
        },
      },
      create: {
        restaurantId: ctx.restaurantId,
        year: parsed.data.year,
        accountCode: row.accountCode,
        monthlyCents: row.monthlyCents,
      },
      update: { monthlyCents: row.monthlyCents },
    });
  }
  return NextResponse.json({ ok: true });
}
