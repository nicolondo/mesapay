import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getErpContext, isDenied } from "@/lib/erp/access";
import { emitDianInvoice, type EmitDianInvoiceResult } from "@/lib/dian/emitInvoice";
import type { ModuleSlug } from "@/lib/modules";

export const dynamic = "force-dynamic";

const GATE: ModuleSlug[] = ["einvoicing"];

/**
 * Detalle que acompaña a un bloqueo: qué campos faltan, con la clave que
 * cada pantalla ya sabe leer (`missingResolution`, `missingLocation`,
 * `missingContact`). Los demás motivos van sólo con `error`.
 */
function blockedDetails(
  r: Extract<EmitDianInvoiceResult, { outcome: "blocked" }>,
): Record<string, string[]> {
  switch (r.reason) {
    case "resolution_incomplete":
      return { missingResolution: r.missing };
    case "location_incomplete":
      return { missingLocation: r.missing };
    case "contact_email_incomplete":
      return { missingContact: r.missing };
    default:
      return {};
  }
}

/**
 * Emite a la DIAN la factura electrónica de una factura simple ya
 * generada. La emisión entera vive en `emitDianInvoice` (idempotente,
 * con los guards que evitan quemar consecutivos); acá sólo se traduce
 * su resultado a HTTP. La venta NUNCA se bloquea — un rechazo/caída deja
 * el documento con estado y errores para reintentar.
 */
async function POSTHandler(
  _req: Request,
  { params }: { params: Promise<{ simpleInvoiceId: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { simpleInvoiceId } = await params;

  const result = await emitDianInvoice({
    simpleInvoiceId,
    restaurantId: ctx.restaurantId,
  });
  switch (result.outcome) {
    case "not_found":
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    case "already_emitted":
      return NextResponse.json({ error: "already_emitted" }, { status: 409 });
    case "blocked":
      return NextResponse.json(
        { error: result.reason, ...blockedDetails(result) },
        { status: 400 },
      );
    default:
      return NextResponse.json({
        document: {
          state: result.outcome,
          cufe: result.cufe,
          qrUrl: result.qrUrl,
          errors: result.errors,
          statusMessage: result.statusMessage,
        },
      });
  }
}

/** Estado del documento DIAN de una factura simple (para la UI). */
async function GETHandler(
  _req: Request,
  { params }: { params: Promise<{ simpleInvoiceId: string }> },
) {
  const ctx = await getErpContext(GATE);
  if (isDenied(ctx)) {
    return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  }
  const { simpleInvoiceId } = await params;
  const doc = await db.dianDocument.findUnique({
    where: { simpleInvoiceId },
    select: { restaurantId: true, state: true, cufe: true, errors: true, kind: true },
  });
  if (!doc || doc.restaurantId !== ctx.restaurantId) {
    return NextResponse.json({ document: null });
  }
  return NextResponse.json({ document: doc });
}

export const POST = secureApi(POSTHandler);

export const GET = secureApi(GETHandler);
