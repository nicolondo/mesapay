import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { getErpContext, isDenied } from "@/lib/erp/access";
import type { ModuleSlug } from "@/lib/modules";
import { appOrigin } from "@/lib/paymentLinks";
import { rateLimit } from "@/lib/rateLimit";
import { emailVoucherBatch } from "@/lib/vouchers/issue";

export const dynamic = "force-dynamic";

/**
 * Reenvía el correo de emisión del lote (mismo correo: códigos, CSV y el
 * link de pago si sigue pendiente). Con límite: es un botón que se
 * aprieta dos veces cuando "no llegó".
 */
const GATE: ModuleSlug[] = ["vouchers"];

async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { id } = await params;
  if (!(await rateLimit(`vouchers:resend:${ctx.restaurantId}:${id}`, 5, 600))) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": "600" } },
    );
  }
  const sent = await emailVoucherBatch({
    restaurantId: ctx.restaurantId,
    batchId: id,
    origin: appOrigin(req),
    locale: await getLocale(),
  });
  if (!sent) {
    return NextResponse.json({ error: "email_failed" }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}

export const POST = secureApi(POSTHandler);
