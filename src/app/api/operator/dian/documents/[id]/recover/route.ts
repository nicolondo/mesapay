import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { rateLimit } from "@/lib/rateLimit";
import { recoverDianInvoice } from "@/lib/dian/invoiceRecovery";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["einvoicing"];

const schema = z.object({ action: z.enum(["resend", "check_status"]) });

/** Reenvíos/consultas por comercio y minuto: un operador apurado, no un script. */
const PER_MINUTE = 20;

/**
 * «Reenviar a la DIAN» / «Consultar en la DIAN» de una factura que la DIAN
 * no dejó aceptada por una causa que ya no aplica (ver
 * dian/invoiceRecovery.ts). Sólo staff con acceso al ERP (operador, admin
 * de grupo, admin de plataforma): `getErpContext` deja afuera a meseros,
 * cocina y caja. La acción tiene que ser la que corresponde a la causa
 * guardada; si no, 409 sin tocar nada.
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
  if (!(await rateLimit(`dian-recover:${ctx.restaurantId}`, PER_MINUTE, 60))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const result = await recoverDianInvoice({
    documentId: id,
    restaurantId: ctx.restaurantId,
    action: parsed.data.action,
    source: "operator",
  });
  const status =
    result.outcome === "not_found"
      ? 404
      : result.outcome === "not_applicable" || result.outcome === "already"
        ? 409
        : result.outcome === "blocked"
          ? 400
          : 200;
  return NextResponse.json({ result }, { status });
}

export const POST = secureApi(POSTHandler);
