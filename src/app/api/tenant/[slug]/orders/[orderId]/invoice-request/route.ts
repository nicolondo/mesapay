import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { issueSimpleInvoice, sendSimpleInvoiceEmail } from "@/lib/simpleInvoice";

/**
 * Customer-submitted billing info attached to an order. We store it
 * verbatim; the restaurant emits the actual electronic invoice through
 * their own provider (Siigo, Alegra, The Factory HKA, etc.) and marks
 * the request as generated from /operator/facturas.
 *
 * La solicitud se puede registrar ANTES de pagar — es lo que pide el
 * checkout, donde el comensal todavía tiene el celular en la mano. Lo que
 * sí depende del pago es la EMISIÓN de la factura imprimible:
 * `issueSimpleInvoice` sólo emite sobre una orden pagada (devuelve
 * `order_not_paid` si no lo está) y en ese caso respondemos
 * `deferred: true` — `issueRequestedInvoiceOnPaid` la emite y la envía
 * cuando el cobro se confirme.
 *
 * One outstanding request per order — if a diner submits twice (e.g.
 * because they typo'd an address) we overwrite the existing pending row
 * instead of stacking them. Already-generated invoices are immutable; if
 * the customer needs a correction the restaurant emits a credit note.
 */

const schema = z.object({
  customerName: z.string().trim().min(2).max(160),
  docType: z.enum(["CC", "CE", "NIT", "PA"]),
  docNumber: z.string().trim().min(4).max(40),
  address: z.string().trim().min(4).max(240),
  city: z.string().trim().min(2).max(80),
  department: z.string().trim().min(2).max(80),
  email: z.string().email().max(160),
  placeId: z.string().max(200).optional(),
  rawComponents: z.unknown().optional(),
});

async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ slug: string; orderId: string }> },
) {
  const { slug, orderId } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
  if (!tenant) {
    return NextResponse.json({ error: "unknown_tenant" }, { status: 404 });
  }
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const data = {
    customerName: parsed.data.customerName,
    docType: parsed.data.docType,
    docNumber: parsed.data.docNumber,
    address: parsed.data.address,
    city: parsed.data.city,
    department: parsed.data.department,
    email: parsed.data.email,
    placeId: parsed.data.placeId ?? null,
    rawComponents:
      parsed.data.rawComponents != null
        ? (parsed.data.rawComponents as Prisma.InputJsonValue)
        : Prisma.JsonNull,
  };

  // Find an existing pending request and overwrite. If it's already
  // generated, refuse — the customer should contact the restaurant.
  const existing = await db.invoiceRequest.findFirst({
    where: { orderId, status: "pending" },
  });
  let request;
  if (existing) {
    request = await db.invoiceRequest.update({
      where: { id: existing.id },
      data,
    });
  } else {
    const generated = await db.invoiceRequest.findFirst({
      where: { orderId, status: "generated" },
    });
    if (generated) {
      return NextResponse.json({ error: "already_generated" }, { status: 409 });
    }
    request = await db.invoiceRequest.create({
      data: { restaurantId: tenant.id, orderId: order.id, ...data },
    });
  }
  publishOrderEvent(tenant.id, { type: "order.updated", orderId: order.id });

  // Además de encolar la solicitud (para la emisión DIAN futura), generamos
  // YA una factura imprimible con los datos del cliente — así el mesero/cliente
  // la imprime en el momento sin esperar a DIAN. Idempotente por orden.
  //
  // Si la orden todavía NO está pagada (el comensal pidió la factura durante
  // el checkout), `issueSimpleInvoice` devuelve `order_not_paid` y no emite
  // nada: la solicitud ya quedó guardada arriba y la factura sale sola cuando
  // se confirme el cobro. No duplicamos la condición acá a propósito — el
  // helper es la única fuente de esa regla.
  const inv = await issueSimpleInvoice({
    tenantId: tenant.id,
    orderId: order.id,
    email: parsed.data.email,
    customer: {
      name: parsed.data.customerName,
      docType: parsed.data.docType,
      docNumber: parsed.data.docNumber,
      address: parsed.data.address,
      city: parsed.data.city,
      department: parsed.data.department,
    },
  });
  if (inv.ok && !inv.alreadyIssued && inv.email) {
    void sendSimpleInvoiceEmail({
      invoiceId: inv.invoiceId,
      snapshot: inv.snapshot,
      invoiceNumber: inv.invoiceNumber,
      invoiceUrl: inv.invoiceUrl,
      email: inv.email,
      locale: inv.locale,
    });
  }

  return NextResponse.json({
    ok: true,
    request,
    replaced: !!existing,
    invoiceUrl: inv.ok ? inv.invoiceUrl : null,
    // El cliente muestra "te la enviamos apenas se confirme el pago" en vez
    // del botón de imprimir.
    deferred: !inv.ok && inv.error === "order_not_paid",
  });
}

export const POST = secureApi(POSTHandler);
