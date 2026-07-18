import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { monthRange } from "@/lib/erp/accounting";
import { PAYROLL_PARAMS_CO_2026 } from "@/lib/erp/payroll";
import {
  effectiveParams,
  generatePayrollRun,
  loadPayrollRun,
} from "@/lib/erp/payrollData";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["staff"];

/** Corrida de nómina del mes + parámetros efectivos del comercio. */
export async function GET(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") ?? "";
  if (!monthRange(month)) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const [run, tenant] = await Promise.all([
    loadPayrollRun(ctx.restaurantId, month),
    db.restaurant.findUnique({
      where: { id: ctx.restaurantId },
      select: { payrollParams: true, country: true },
    }),
  ]);
  return NextResponse.json({
    month,
    run,
    params: effectiveParams(tenant?.payrollParams, tenant?.country ?? null),
    // Catálogo con labels/tipo para la UI de parámetros.
    catalog: PAYROLL_PARAMS_CO_2026,
  });
}

/** Genera (o regenera) la corrida del mes. */
export async function POST(req: Request) {
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
  await generatePayrollRun(ctx.restaurantId, month, range);
  const run = await loadPayrollRun(ctx.restaurantId, month);
  return NextResponse.json({ month, run });
}

const patchSchema = z.object({
  // Objeto completo { key: number }; reemplaza los parámetros del comercio.
  params: z.record(z.string().min(1).max(60), z.number().finite()),
});

/** Guarda los parámetros de liquidación del comercio. */
export async function PATCH(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  await db.restaurant.update({
    where: { id: ctx.restaurantId },
    data: { payrollParams: parsed.data.params },
  });
  return NextResponse.json({ ok: true, params: parsed.data.params });
}
