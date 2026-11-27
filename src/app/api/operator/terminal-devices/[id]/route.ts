import { terminalSerial } from "@/lib/payments/terminalHealth";
import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

const patchSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  active: z.boolean().optional(),
  // Serial físico del datáfono (Cloud Terminal API). "" → null.
  serialNumber: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .optional()
    .transform((v) => (v ? v : v === "" ? null : v)),
  // (Ya no hay "mesero asignado": los datáfonos son del comercio y quien
  // cobra elige a cuál mandar el cobro. Un `assignedUserId` en el body se
  // ignora; la columna queda sin uso.)
});

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

/**
 * Configuración de un datáfono del comercio (Configuración → Datáfonos):
 * nombre, activo y serial. El datáfono es del COMERCIO: cualquiera del
 * equipo cobra con él y elige a cuál mandar el cobro al cobrar.
 */
async function PATCHHandler(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || !guard(session.user.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const updated = await db.$transaction(async tx => {
    const [device] = await tx.$queryRaw<{ kushkiDeviceId: string; serialNumber: string | null }[]>`
      SELECT "kushkiDeviceId", "serialNumber" FROM "TerminalDevice"
      WHERE id = ${id} AND "restaurantId" = ${restaurantId} FOR UPDATE`;
    if (!device) return null;
    const { label, active, serialNumber } = parsed.data;
    if (serialNumber !== undefined && serialNumber !== device.serialNumber) {
      await tx.auditEvent.create({ data: {
        restaurantId, kind: "terminal.serial.changed", targetType: "terminal", targetId: device.kushkiDeviceId,
        actorUserId: session.user.id, actorEmail: session.user.email ?? "", actorRole: session.user.role,
        occurredAt: new Date(), summary: `${terminalSerial(device)} → ${terminalSerial({ ...device, serialNumber })}`,
        diff: { previousSerial: terminalSerial(device), serialNumber },
      } });
    }
    return tx.terminalDevice.update({
      where: { id }, data: { label, active, serialNumber },
      select: { id: true, label: true, active: true, serialNumber: true },
    });
  });
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({ ok: true, device: updated });
}

export const PATCH = secureApi(PATCHHandler);
