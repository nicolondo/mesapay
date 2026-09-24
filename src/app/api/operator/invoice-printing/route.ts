import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { recordAuditEvent } from "@/lib/auditLog";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/operator/invoice-printing
 * body: { invoicePrinterId?: string | null, invoiceAutoPrint?: boolean }
 *
 * La sección "Facturas" de Configuración → Impresoras:
 *
 *   · `invoicePrinterId`: por cuál impresora sale la factura del cliente.
 *     null = todas las activas de tipo factura (como siempre). Tiene que
 *     ser una impresora DEL comercio y estar ACTIVA — elegir una apagada
 *     dejaría al local sin facturas sin que nadie lo note hasta que un
 *     cliente pregunte por su papel.
 *   · `invoiceAutoPrint`: si la factura sale sola (al cobrar, o al
 *     aceptarla la DIAN con facturación electrónica). Apagado, sólo la
 *     reimpresión manual desde Pedidos.
 *
 * Ver src/lib/print/invoiceQueue.ts para la regla completa.
 */
const patchSchema = z
  .object({
    invoicePrinterId: z.string().trim().min(1).max(64).nullable().optional(),
    invoiceAutoPrint: z.boolean().optional(),
  })
  .refine(
    (b) => b.invoicePrinterId !== undefined || b.invoiceAutoPrint !== undefined,
  );

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

async function PATCHHandler(req: Request) {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const { invoicePrinterId, invoiceAutoPrint } = parsed.data;

  if (invoicePrinterId) {
    // 404 y no 403 para la impresora de otro comercio: no se confirma ni
    // la existencia de recursos ajenos.
    const printer = await db.printer.findFirst({
      where: { id: invoicePrinterId, restaurantId },
      select: { id: true, active: true },
    });
    if (!printer) {
      return NextResponse.json({ error: "printer_not_found" }, { status: 404 });
    }
    if (!printer.active) {
      return NextResponse.json({ error: "printer_inactive" }, { status: 409 });
    }
  }

  const updated = await db.restaurant.update({
    where: { id: restaurantId },
    data: {
      ...(invoicePrinterId !== undefined && { invoicePrinterId }),
      ...(invoiceAutoPrint !== undefined && { invoiceAutoPrint }),
    },
    select: { invoicePrinterId: true, invoiceAutoPrint: true },
  });

  await recordAuditEvent({
    kind: "printer.invoice_settings.update",
    restaurantId,
    target: { type: "restaurant", id: restaurantId },
    summary: `Impresión de facturas: impresora ${updated.invoicePrinterId ?? "todas las de factura"}, automática ${updated.invoiceAutoPrint ? "sí" : "no"}`,
    diff: { after: updated },
  });

  return NextResponse.json({ ok: true, settings: updated });
}

export const PATCH = secureApi(PATCHHandler);
