import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

/**
 * Crear un datáfono (TerminalDevice) desde Configuración → Datáfonos.
 * El comercio carga un nombre + el SERIAL físico del equipo (Cloud
 * Terminal API). `kushkiDeviceId` es un id interno único — para devices
 * cloud no se usa como identificador de cobro (ese es el serial), pero
 * la columna es @unique/obligatoria, así que generamos uno.
 */

const createSchema = z.object({
  label: z.string().trim().min(1).max(80),
  serialNumber: z.string().trim().max(64).optional(),
});

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

export async function POST(req: Request) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const device = await db.terminalDevice.create({
    data: {
      restaurantId,
      kushkiDeviceId: `term_${randomUUID()}`,
      label: parsed.data.label,
      serialNumber: parsed.data.serialNumber || null,
      active: true,
    },
    select: {
      id: true,
      label: true,
      kushkiDeviceId: true,
      serialNumber: true,
      active: true,
      assignedUserId: true,
      lastSeenAt: true,
    },
  });

  return NextResponse.json({ ok: true, device });
}
