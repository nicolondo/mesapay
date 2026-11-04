import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/auditLog";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { publishOrderEvent } from "@/lib/events";
import { preInvoiceStatus, preIssueInvoice } from "@/lib/preInvoice";

export const dynamic = "force-dynamic";

/**
 * POST /api/operator/orders/[id]/pre-invoice — "Imprimir factura" ANTES de
 * cobrar: emite la factura de la cuenta abierta sin método de pago (ver
 * `src/lib/preInvoice.ts`) y la manda a la impresora de facturas.
 *
 * Quién: el mismo staff que imprime la precuenta (`requireOperatorScope`:
 * operador, admins y el MESERO, que es quien se la lleva al cliente). El
 * comensal nunca.
 *
 * Responde `{ ok, invoiceId, documentNumber, alreadyIssued, einvoicing,
 * dian, print }`. `print.queued: false` con `no_printer` / `agent_offline`
 * ⇒ la pantalla imprime `/factura/[id]` desde el navegador; con
 * `waiting_dian` ⇒ la DIAN todavía no la aceptó: sale sola cuando la acepte
 * y, mientras, el mesero puede llevar la precuenta. Idempotente: volver a
 * llamarla no emite otra factura ni imprime otra copia.
 *
 * GET — el estado (DIAN, pagada) sin emitir nada, para el "¿ya salió?".
 */
async function POSTHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const scope = await requireOperatorScope();
  if (isScopeError(scope)) {
    return NextResponse.json(
      { error: scope.error },
      { status: scope.error === "forbidden" ? 403 : 400 },
    );
  }
  const { id: orderId } = await params;
  const result = await preIssueInvoice({ restaurantId: scope.restaurantId, orderId });
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }

  if (!result.alreadyIssued) {
    await recordAuditEvent({
      kind: "invoice.pre_issue",
      restaurantId: scope.restaurantId,
      target: { type: "order", id: orderId },
      summary: `Emitió la factura ${result.documentNumber} antes de cobrar`,
      diff: {
        after: {
          invoiceId: result.invoiceId,
          dian: result.dian?.state ?? null,
          printed: result.print.queued,
        },
      },
    });
    // La ficha de la mesa (y el Salón) muestran "Facturada".
    publishOrderEvent(scope.restaurantId, { type: "order.updated", orderId });
  }
  return NextResponse.json(result);
}

async function GETHandler(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const scope = await requireOperatorScope();
  if (isScopeError(scope)) {
    return NextResponse.json(
      { error: scope.error },
      { status: scope.error === "forbidden" ? 403 : 400 },
    );
  }
  const { id: orderId } = await params;
  const result = await preInvoiceStatus({ restaurantId: scope.restaurantId, orderId });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 404 });
  }
  return NextResponse.json(result);
}

export const POST = secureApi(POSTHandler);
export const GET = secureApi(GETHandler);
