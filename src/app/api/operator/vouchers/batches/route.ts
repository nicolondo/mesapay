import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";
import { appOrigin } from "@/lib/paymentLinks";
import {
  emailVoucherBatch,
  issueBatchSchema,
  issueVoucherBatch,
} from "@/lib/vouchers/issue";

export const dynamic = "force-dynamic";

/**
 * Lotes de bonos del comercio. POST emite: crea el lote + N bonos (y el
 * link de pago si el modo es prepago) y manda el correo de emisión a la
 * empresa. El correo es best-effort y NO frena la emisión: si Resend
 * falla, el lote existe igual y el operador lo reenvía desde el detalle.
 */
const GATE: ModuleSlug[] = ["vouchers"];

async function GETHandler() {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const batches = await db.voucherBatch.findMany({
    where: { restaurantId: ctx.restaurantId },
    orderBy: { issuedAt: "desc" },
    take: 200,
    select: {
      id: true,
      mode: true,
      status: true,
      quantity: true,
      unitValueCents: true,
      expiresAt: true,
      issuedAt: true,
      paidAt: true,
      emailSentAt: true,
      billingCustomer: { select: { id: true, customerName: true, email: true } },
    },
  });
  return NextResponse.json({ batches });
}

async function POSTHandler(req: Request) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const parsed = issueBatchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", fieldErrors: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const result = await issueVoucherBatch({
    restaurantId: ctx.restaurantId,
    userId: ctx.userId,
    input: parsed.data,
  });
  if (!result.ok) {
    const status = result.error === "customer_not_found" ? 404 : 500;
    return NextResponse.json({ error: result.error }, { status });
  }
  const emailed = await emailVoucherBatch({
    restaurantId: ctx.restaurantId,
    batchId: result.batch.id,
    origin: appOrigin(req),
    locale: await getLocale(),
  });
  return NextResponse.json({ batch: result.batch, emailed }, { status: 201 });
}

export const GET = secureApi(GETHandler);
export const POST = secureApi(POSTHandler);
