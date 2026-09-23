import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { enqueueInvoicePrintTest } from "@/lib/print/testTicket";

export const dynamic = "force-dynamic";

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

/**
 * POST /api/operator/invoice-printing/test-print
 *
 * Encola una factura de PRUEBA por el mismo camino que una factura real:
 * la impresora elegida en Configuración (o todas las de tipo factura),
 * con el ancho de cada una y el QR sólo en las que tienen `supportsQr`.
 * Es lo que contesta "¿por dónde va a salir la factura y cómo se ve?" sin
 * tener que cobrar una cuenta de verdad — y, con facturación electrónica,
 * si el QR sale legible en ESA térmica antes de prender el check.
 *
 * Devuelve 202 y cuántos trabajos encoló: encolar no es imprimir. Lo que
 * dice si salió es el acuse del agente, en la lista de trabajos recientes.
 * 404 `no_printer` cuando no hay ninguna impresora activa para facturas.
 */
async function POSTHandler() {
  const session = await auth();
  if (!guard(session?.user?.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const jobs = await enqueueInvoicePrintTest({ restaurantId });
  if (jobs === 0) {
    return NextResponse.json({ error: "no_printer" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, jobs }, { status: 202 });
}

export const POST = secureApi(POSTHandler);
