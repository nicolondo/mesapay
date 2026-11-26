import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/auditLog";
import { requireOperatorScope, isScopeError } from "@/lib/operatorScope";
import { STAFF_PRINT_ROLES } from "@/lib/print/staffPrint";
import { listTerminalPrintDevices, printOnTerminalDevice } from "@/lib/print/terminalPrint";

export const dynamic = "force-dynamic";

/**
 * POST /api/operator/print/terminal — imprime en la impresora integrada del
 * datáfono Kushki (Print API cloud). Es «Este dispositivo» del usuario
 * Datáfono: su app instalada (Firefox 107) no puede abrir la impresión del
 * sistema (ver `lib/print/terminalPrint.ts`).
 *
 * Cuerpo: `{ kind: "invoice" | "prebill", orderId, deviceId? }` o
 * `{ kind: "shift", shiftId, deviceId? }`. `deviceId` es el datáfono que el
 * equipo recuerda («este datáfono es: X»).
 *
 * Tras encolar (202) espera el estado REAL del trabajo (`/sync/print_job`,
 * hasta ~30 s): `state: "printed"` sólo con COMPLETED; `"queued"` si sigue
 * pendiente (se reintenta con el mismo `printJobId`); FAILED es 502
 * `print_failed` con `errorCode` (OUT_OF_PAPER…).
 *
 * Respuestas: `{ ok: true, state, printJobId, deviceId, deviceLabel, simulated }`, o
 * 409 `choose_device` (con `devices`), `no_devices`,
 * `cloud_business_code_missing`, `mock_print_disabled`, `order_closed`,
 * `no_items`; 404 `not_found`/`no_invoice`; 502 `print_failed` (con
 * `reason`). El cierre de turno sólo desde el panel del operador.
 */
// Reintento de un trabajo encolado: el MISMO id (el datáfono deduplica).
const printJobId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional();
const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("invoice"), orderId: z.string().min(1).max(64), deviceId: z.string().max(128).optional(), printJobId }),
  z.object({ kind: z.literal("prebill"), orderId: z.string().min(1).max(64), deviceId: z.string().max(128).optional(), printJobId }),
  z.object({ kind: z.literal("shift"), shiftId: z.string().min(1).max(64), deviceId: z.string().max(128).optional(), printJobId }),
]);

const SHIFT_ROLES = new Set(["operator", "platform_admin", "group_admin"]);

const STATUS: Record<string, number> = {
  not_found: 404,
  no_invoice: 404,
  print_failed: 502,
};

async function POSTHandler(req: Request) {
  const scope = await requireOperatorScope(STAFF_PRINT_ROLES);
  if (isScopeError(scope)) {
    return NextResponse.json({ error: scope.error }, { status: scope.error === "forbidden" ? 403 : 400 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const body = parsed.data;
  if (body.kind === "shift" && !SHIFT_ROLES.has(scope.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const result = await printOnTerminalDevice({
    restaurantId: scope.restaurantId,
    userId: scope.userId,
    target: body.kind === "shift" ? { kind: "shift", shiftId: body.shiftId } : { kind: body.kind, orderId: body.orderId },
    deviceId: body.deviceId ?? null,
    printJobId: body.printJobId ?? null,
  });
  if (!result.ok) {
    if (result.error === "print_failed") {
      console.error("[print/terminal] el datáfono no imprimió", {
        restaurantId: scope.restaurantId,
        kind: body.kind,
        reason: result.reason,
        errorCode: result.errorCode,
        printJobId: result.printJobId,
      });
    }
    return NextResponse.json(
      {
        error: result.error,
        ...(result.devices && { devices: result.devices }),
        ...(result.reason && { reason: result.reason }),
        ...(result.errorCode && { errorCode: result.errorCode }),
        ...(result.errorMessage && { errorMessage: result.errorMessage }),
        ...(result.printJobId && { printJobId: result.printJobId }),
      },
      { status: STATUS[result.error] ?? 409 },
    );
  }

  await recordAuditEvent({
    kind: body.kind === "shift" ? "shift.close.print" : body.kind === "prebill" ? "order.prebill.print" : "invoice.reprint",
    restaurantId: scope.restaurantId,
    target: body.kind === "shift" ? { type: "shift", id: body.shiftId } : { type: "order", id: body.orderId },
    summary: `${result.state === "printed" ? "Imprimió" : "Encoló (sin confirmar)"} ${result.reference} en el datáfono ${result.deviceLabel}${result.simulated ? " (simulado)" : ""}`,
  });
  return NextResponse.json({
    ok: true,
    state: result.state,
    printJobId: result.printJobId,
    deviceId: result.deviceId,
    deviceLabel: result.deviceLabel,
    simulated: result.simulated,
  });
}

/**
 * GET: los datáfonos a los que se puede imprimir (`{ devices }`). Con la
 * lista vacía, «Imprimir en» no ofrece «Datáfono».
 */
async function GETHandler() {
  const scope = await requireOperatorScope(STAFF_PRINT_ROLES);
  if (isScopeError(scope)) {
    return NextResponse.json({ error: scope.error }, { status: scope.error === "forbidden" ? 403 : 400 });
  }
  return NextResponse.json({ devices: await listTerminalPrintDevices(scope.restaurantId) });
}

export const POST = secureApi(POSTHandler);
export const GET = secureApi(GETHandler);
