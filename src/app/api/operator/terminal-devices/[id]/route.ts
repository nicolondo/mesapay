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
  if (!guard(session?.user?.role)) {
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

  const device = await db.terminalDevice.findUnique({ where: { id } });
  if (!device || device.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const updated = await db.terminalDevice.update({
    where: { id },
    data: {
      ...(parsed.data.label !== undefined && { label: parsed.data.label }),
      ...(parsed.data.active !== undefined && { active: parsed.data.active }),
      ...(parsed.data.serialNumber !== undefined && {
        serialNumber: parsed.data.serialNumber,
      }),
    },
    select: {
      id: true,
      label: true,
      active: true,
      serialNumber: true,
    },
  });

  return NextResponse.json({ ok: true, device: updated });
}

export const PATCH = secureApi(PATCHHandler);
