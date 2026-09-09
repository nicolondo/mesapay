import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { enqueuePrinterTest } from "@/lib/print/testTicket";

function guard(role?: string) {
  return role === "operator" || role === "platform_admin";
}

/**
 * POST /api/operator/printers/{id}/test-print
 *
 * Encola una tirilla de prueba. Es la razón de ser de la pantalla: hasta
 * ahora la única prueba posible era un botón DENTRO de la pestaña de
 * Chrome del PC de la cocina, así que verificar la impresora de la cocina
 * exigía estar en la cocina. Ahora la prueba nace en el servidor y el
 * agente la escribe en la impresora real.
 *
 * Devuelve 202 y el id del trabajo: encolar no es imprimir. Lo que dice
 * si salió o no es el acuse del agente, que la misma pantalla muestra en
 * la lista de trabajos recientes.
 */
export async function POST(
  _req: Request,
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

  const jobId = await enqueuePrinterTest({ restaurantId, printerId: id });
  // 404 y no 403 cuando la impresora es de otro comercio: no se confirma
  // ni la existencia de recursos ajenos.
  if (!jobId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, jobId }, { status: 202 });
}
