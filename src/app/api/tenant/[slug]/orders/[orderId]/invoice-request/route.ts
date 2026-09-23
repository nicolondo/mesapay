import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { issueSimpleInvoice } from "@/lib/simpleInvoice";
import { deliverInvoiceEmail } from "@/lib/invoiceDelivery";
import { normalizeCustomerDocument } from "@/lib/customerDocument";

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
 * `deferred: true` — `issueInvoiceOnPaid` la emite y la envía
 * cuando el cobro se confirme.
 *
 * One outstanding request per order — if a diner submits twice (e.g.
 * because they typo'd their document) we overwrite the existing pending row
 * instead of stacking them. Already-generated invoices are immutable; if
 * the customer needs a correction the restaurant emits a credit note.
 *
 * Dirección, ciudad y departamento son OPCIONALES: el formulario ya no los
 * pide (la factura electrónica sale sin el bloque de dirección del
 * adquiriente, como la de consumidor final). Si un cliente viejo los manda
 * igual, se validan como antes y se guardan; ausentes o vacíos ⇒ null.
 *
 * La identificación se guarda SIN dígito de verificación: sólo el número,
 * que es lo que se muestra en la tirilla, el correo y la ficha de la cuenta.
 * El DV del NIT lo calcula la emisión a la DIAN (`customerPartyFor`) cuando
 * arma el XML. Si el comensal igual escribe "901.944.469-1" se separa; un DV
 * que no corresponde se rechaza con `code` para que el formulario lo diga
 * claro (ver src/lib/customerDocument.ts).
 */

const optionalText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null)
    .refine((v) => v === null || v.length >= min);

const schema = z.object({
  customerName: z.string().trim().min(2).max(160),
  docType: z.enum(["CC", "CE", "NIT", "PA"]),
  docNumber: z.string().trim().min(4).max(40),
  address: optionalText(4, 240),
  city: optionalText(2, 80),
  department: optionalText(2, 80),
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
  const document = normalizeCustomerDocument(parsed.data.docType, parsed.data.docNumber);
  if (!document.ok) {
    return NextResponse.json(
      { error: "invalid", code: document.error },
      { status: 400 },
    );
  }

  const data = {
    customerName: parsed.data.customerName,
    docType: parsed.data.docType,
    docNumber: document.docNumber,
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
      docNumber: document.docNumber,
      address: parsed.data.address,
      city: parsed.data.city,
      department: parsed.data.department,
    },
  });
  // Qué correo va (comprobante vs. factura electrónica) lo decide UN solo
  // lugar: invoiceDelivery.ts. Con `einvoicing` activo NUNCA sale el
  // comprobante; y si la DIAN ya aceptó la factura sin destinatario, el
  // correo que el comensal acaba de dejar la hace salir ahora.
  if (inv.ok) {
    void deliverInvoiceEmail({
      tenant: { id: tenant.id, enabledModules: tenant.enabledModules },
      invoice: {
        invoiceId: inv.invoiceId,
        invoiceNumber: inv.invoiceNumber,
        invoiceUrl: inv.invoiceUrl,
        snapshot: inv.snapshot,
        email: inv.email ?? parsed.data.email,
        locale: inv.locale,
      },
      firstIssuance: !inv.alreadyIssued,
      emailJustProvided: inv.alreadyIssued && !inv.email,
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
