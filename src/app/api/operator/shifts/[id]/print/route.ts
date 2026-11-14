import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auditLog";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { enqueueShiftCloseTicket } from "@/lib/print/shiftCloseQueue";
import { wantsDevicePrint } from "@/lib/print/devicePrintRequest";

export const dynamic = "force-dynamic";

/**
 * POST /api/operator/shifts/[id]/print — la TIRILLA del cierre de turno.
 *
 *   - Sin cuerpo («Impresora de caja»): la encola en la impresora de
 *     facturas del local por el agente, como la factura y la precuenta.
 *     Sin impresora (o con el agente caído) responde `queued: false` con
 *     el motivo y el cliente imprime la vista `/operator/shifts/[id]/tirilla`
 *     desde el navegador — el respaldo de siempre.
 *   - `{ destination: "device" }` («Este dispositivo»): no encola nada;
 *     valida el turno, deja el rastro y responde `reason: "device"`. El
 *     cliente imprime la tirilla al papel de su equipo.
 *
 * Quién: los que ven el reporte del turno (el panel del operador). Un
 * turno de otro comercio es 404.
 */
const SHIFT_PRINT_ROLES = ["operator", "platform_admin", "group_admin"] as const;

async function POSTHandler(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = await requireOperatorScope(SHIFT_PRINT_ROLES);
  if (isScopeError(scope)) {
    return NextResponse.json(
      { error: scope.error },
      { status: scope.error === "forbidden" ? 403 : 400 },
    );
  }
  const { id: shiftId } = await params;
  const shift = await db.shift.findUnique({
    where: { id: shiftId },
    select: { id: true, restaurantId: true },
  });
  if (!shift || shift.restaurantId !== scope.restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (await wantsDevicePrint(req)) {
    await recordAuditEvent({
      kind: "shift.close.print",
      restaurantId: scope.restaurantId,
      target: { type: "shift", id: shift.id },
      summary: "Imprimió el cierre de turno en su dispositivo",
    });
    return NextResponse.json({ queued: false, reason: "device" });
  }

  const result = await enqueueShiftCloseTicket({
    restaurantId: scope.restaurantId,
    shiftId: shift.id,
    requestedByUserId: scope.userId,
  });
  if (!result.queued && result.reason === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  await recordAuditEvent({
    kind: "shift.close.print",
    restaurantId: scope.restaurantId,
    target: { type: "shift", id: shift.id },
    summary: result.queued
      ? `Imprimió el cierre de turno en ${result.printerName}`
      : `Abrió el cierre de turno para imprimir desde el navegador (${result.reason})`,
  });
  return NextResponse.json(result);
}

export const POST = secureApi(POSTHandler);
