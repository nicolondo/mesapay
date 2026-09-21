import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { deleteBudget, loadBudgetExecution, upsertBudget } from "@/lib/erp/budgets";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["accounting"];

/** `?year=2026&month=9` o `?month=2026-09` → {year, month}; null si no sirve. */
function parsePeriod(searchParams: URLSearchParams): { year: number; month: number } | null {
  const monthRaw = searchParams.get("month") ?? "";
  const ym = /^(\d{4})-(\d{2})$/.exec(monthRaw);
  const year = ym ? Number(ym[1]) : Number(searchParams.get("year"));
  const month = ym ? Number(ym[2]) : Number(monthRaw);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * Ejecución del presupuesto del mes (presupuesto vs. real por cuenta y
 * centro, con semáforo) + todos los presupuestos del año.
 */
async function GETHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const period = parsePeriod(new URL(req.url).searchParams);
  if (!period) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const execution = await loadBudgetExecution(ctx.restaurantId, period.year, period.month);
  return NextResponse.json(execution);
}

// La forma la valida zod; las reglas (cuenta del plan, centro activo,
// rangos) las devuelve `upsertBudget` con su código.
const bodySchema = z.object({
  accountCode: z.string().max(20),
  costCenterId: z.string().max(64).nullable().optional(),
  year: z.number().int(),
  month: z.number().int().nullable().optional(),
  amountCents: z.number().int(),
  /** true → la fila aplica a todos los meses del año (month = null). */
  allMonths: z.boolean().optional(),
});

/**
 * Crea (201) o actualiza (200) el presupuesto del alcance (año, mes | todo
 * el año, cuenta, centro | general). 400 con el código de validación; 409
 * si otra alta ganó la carrera por el mismo alcance.
 */
async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const b = parsed.data;
  const month = b.allMonths ? null : (b.month ?? null);
  if (month === null && !b.allMonths) {
    return NextResponse.json({ error: "invalid_month" }, { status: 400 });
  }
  const r = await upsertBudget(ctx.restaurantId, {
    accountCode: b.accountCode,
    costCenterId: b.costCenterId ?? null,
    year: b.year,
    month,
    amountCents: b.amountCents,
  });
  if (!r.ok) {
    return NextResponse.json({ error: r.error }, { status: r.error === "duplicate" ? 409 : 400 });
  }
  return NextResponse.json(
    { ok: true, budget: r.budget, created: r.created },
    { status: r.created ? 201 : 200 },
  );
}

/** Borra un presupuesto (`?id=`). */
async function DELETEHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const id = (new URL(req.url).searchParams.get("id") ?? "").trim();
  if (!id) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const r = await deleteBudget(ctx.restaurantId, id);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const GET = secureApi(GETHandler);

export const POST = secureApi(POSTHandler);

export const DELETE = secureApi(DELETEHandler);
