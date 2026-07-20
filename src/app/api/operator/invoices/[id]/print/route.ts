import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import type { InvoiceSnapshot } from "@/lib/invoice";
import { invoiceUrlFor } from "@/lib/simpleInvoice";
import {
  buildInvoiceCommands,
  printOnCloudTerminal,
} from "@/lib/payments/kushki/cloudPrint";

/**
 * Imprime la factura (tirilla) en el datáfono SmartPOS vía el Print API
 * cloud de Kushki. Si el comercio tiene varios datáfonos activos y no se
 * indica cuál, responde 409 con la lista para que la UI muestre el picker.
 */

const schema = z.object({
  deviceId: z.string().min(1).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const invoice = await db.simpleInvoice.findUnique({ where: { id } });
  if (!invoice || invoice.restaurantId !== restaurantId) {
    return NextResponse.json({ error: "invoice_not_found" }, { status: 404 });
  }

  const devices = await db.terminalDevice.findMany({
    where: { restaurantId, active: true, serialNumber: { not: null } },
    select: { id: true, label: true, serialNumber: true },
    orderBy: { label: "asc" },
  });
  if (devices.length === 0) {
    return NextResponse.json({ error: "no_devices" }, { status: 409 });
  }
  const device = parsed.data.deviceId
    ? devices.find((d) => d.id === parsed.data.deviceId)
    : devices.length === 1
      ? devices[0]
      : undefined;
  if (!device) {
    return NextResponse.json(
      {
        error: "choose_device",
        devices: devices.map((d) => ({ id: d.id, label: d.label })),
      },
      { status: 409 },
    );
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { cloudTerminalBusinessCode: true, kushkiMode: true },
  });
  const snapshot = invoice.snapshot as unknown as InvoiceSnapshot;
  const commands = buildInvoiceCommands(
    snapshot,
    invoice.invoiceNumber,
    invoiceUrlFor(invoice.id),
  );

  const result = await printOnCloudTerminal({
    serialNumber: device.serialNumber!,
    commands,
    businessCode: tenant?.cloudTerminalBusinessCode,
    mode: await getRestaurantKushkiMode(tenant),
    // Idempotencia por factura+equipo: reintentar no imprime doble
    // (el datáfono deduplica por printJobId).
    printJobId: `inv-${invoice.id}-${device.id}`,
    externalReference: `invoice-${invoice.invoiceNumber}`,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: "print_failed",
        message: result.message ?? "El datáfono no aceptó la impresión.",
        httpStatus: result.httpStatus,
      },
      { status: 502 },
    );
  }
  return NextResponse.json({
    ok: true,
    printJobId: result.printJobId,
    status: result.status ?? "PENDING",
  });
}
