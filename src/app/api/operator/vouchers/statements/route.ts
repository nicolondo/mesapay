import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";
import { appOrigin } from "@/lib/paymentLinks";
import {
  closeVoucherStatement,
  dayRange,
  emailVoucherStatement,
} from "@/lib/vouchers/statement";

export const dynamic = "force-dynamic";

/**
 * "Cerrar corte": agrupa las redenciones de una empresa en el rango que
 * todavía no entraron en ningún corte, crea el VoucherStatement y manda
 * el resumen a la empresa (con link de pago si hay bonos a crédito).
 * El correo es best-effort: si no sale, el corte existe igual y se
 * reenvía desde el reporte.
 *
 * POST { billingCustomerId, from: "YYYY-MM-DD", to: "YYYY-MM-DD" }
 */
const GATE: ModuleSlug[] = ["vouchers"];

const schema = z.object({
  billingCustomerId: z.string().trim().min(1),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const range = dayRange(parsed.data.from, parsed.data.to);
  if (!range) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const result = await closeVoucherStatement({
    restaurantId: ctx.restaurantId,
    billingCustomerId: parsed.data.billingCustomerId,
    from: range.from,
    to: range.to,
    userId: ctx.userId,
  });
  if (!result.ok) {
    const status = result.error === "customer_not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }
  const emailed = await emailVoucherStatement({
    restaurantId: ctx.restaurantId,
    statementId: result.statementId,
    origin: appOrigin(req),
    locale: await getLocale(),
  });
  return NextResponse.json({ statement: result, emailed }, { status: 201 });
}

export const POST = secureApi(POSTHandler);
