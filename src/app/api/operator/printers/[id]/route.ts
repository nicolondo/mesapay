import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";

/**
 * Lo ÚNICO editable desde la web. El rótulo, la IP, el puerto, la
 * estación y el ancho salen de la config del programa que corre en el
 * local (POST /api/print-agent/printers) y acá sólo se muestran: quien
 * instala está parado frente a la impresora, y una web que edite IPs
 * garantiza que la web y el PC digan cosas distintas.
 *
 * Apagar sí tiene sentido remoto: la impresora se dañó a las 8pm, el
 * dueño la saca de la cola desde el teléfono y las comandas dejan de
 * encolarse contra un aparato que no va a imprimir. El agente se entera
 * en su próximo latido; en su siguiente publicación de config la
 * impresora vuelve a quedar como diga el programa.
 *
 * `supportsQr` también se decide acá y no en el programa: es algo que se
 * sabe MIRANDO el papel (¿salió el QR de la factura de prueba o salió
 * basura?), y el agente no lo publica, así que sobrevive a cada
 * republicación de la config.
 */
const patchSchema = z
  .object({
    active: z.boolean().optional(),
    supportsQr: z.boolean().optional(),
  })
  .refine((b) => b.active !== undefined || b.supportsQr !== undefined);

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

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

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const printer = await db.printer.findFirst({
    where: { id, restaurantId },
    select: { id: true },
  });
  if (!printer) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { active, supportsQr } = parsed.data;
  const updated = await db.printer.update({
    where: { id: printer.id },
    data: {
      ...(active !== undefined && { active }),
      ...(supportsQr !== undefined && { supportsQr }),
    },
    select: { id: true, active: true, supportsQr: true },
  });
  return NextResponse.json({ ok: true, printer: updated });
}

export const PATCH = secureApi(PATCHHandler);
