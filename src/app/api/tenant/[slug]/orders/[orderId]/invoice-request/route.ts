import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { publishOrderEvent } from "@/lib/events";
import { issueSimpleInvoice } from "@/lib/simpleInvoice";
import { deliverInvoiceEmail } from "@/lib/invoiceDelivery";
import { normalizeCustomerDocument } from "@/lib/customerDocument";
import { COLLECTOR_ROLES, staffForRestaurant } from "@/lib/staffAccess";
import { applyCustomerDiscount, type ApplyCustomerDiscountResult } from "@/lib/customerDiscount";
import { ORDER_INVOICED } from "@/lib/orders/orderInvoicedError";
import { formatInvoiceNumber, type InvoiceSnapshot } from "@/lib/invoice";
import { BILLING_CUSTOMER_WRITE_ROLES } from "@/lib/billingCustomers";
import {
  invoiceDocTypeSchema,
  invoiceRequestFieldsSchema,
  validateInvoiceFields,
  type InvoiceRequestFields,
} from "@/lib/invoiceRequestInput";
import { invoiceSummaryFor, type MemoryActor } from "@/lib/invoiceCustomerMemory";
import { storedExtraEmails } from "@/lib/invoiceEmails";
import {
  auditSavedCustomerUse,
  consumeLookupToken,
  rememberInvoiceCustomer,
} from "@/lib/invoiceCustomerMemoryQueries";

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
 *
 * "Recordar mis datos" (src/lib/invoiceCustomerMemory.ts): llega por dos
 * caminos.
 *  - Datos ESCRITOS + `rememberCustomer` (la casilla; ausente = false, que
 *    es lo que manda un cliente viejo que no la mostraba): después de
 *    guardar la solicitud se crea o actualiza el cliente guardado según
 *    quién pide (comensal, mesero o administrador). Nunca bloquea la
 *    factura.
 *  - `savedCustomerToken` ("Usar estos datos"): el comensal sólo vio los
 *    datos enmascarados; la solicitud se arma ACÁ con el registro guardado,
 *    validado igual que uno escrito. Desde ese camino no se aplica ningún
 *    beneficio del cliente (crédito, descuento, bonos), y a quien no es
 *    personal no se le devuelven los datos completos ni el enlace de la
 *    factura: le llega al correo guardado.
 */

const typedSchema = invoiceRequestFieldsSchema.extend({
  placeId: z.string().max(200).optional(),
  rawComponents: z.unknown().optional(),
  // Sólo desde el checkout del STAFF: el cliente de facturación elegido en
  // el selector. Liga la cuenta al cliente y aplica su descuento comercial
  // (si lo tiene). Sin sesión de staff del comercio se ignora.
  billingCustomerId: z.string().min(1).max(64).optional(),
  // La casilla "Recordar mis datos". Ausente = no se preguntó = no se guarda.
  rememberCustomer: z.boolean().optional(),
});

const savedSchema = z.object({
  savedCustomerToken: z.string().min(10).max(160),
  docType: invoiceDocTypeSchema,
  docNumber: z.string().trim().min(4).max(40),
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
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { simpleInvoice: { select: { id: true, invoiceNumber: true, snapshot: true } } },
  });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  }
  // Factura emitida ANTES de cobrar: el adquiriente ya quedó en ella (y en
  // el XML que va a la DIAN). Cambiarlo ahora sería otra factura: se anula
  // con nota crédito. Con la cuenta ya pagada sigue el camino de siempre
  // (la solicitud tardía queda pendiente en Facturas).
  if (order.simpleInvoice && order.status !== "paid") {
    return NextResponse.json(
      {
        error: ORDER_INVOICED,
        invoice: {
          invoiceId: order.simpleInvoice.id,
          documentNumber: formatInvoiceNumber(
            order.simpleInvoice.snapshot as unknown as InvoiceSnapshot,
            order.simpleInvoice.invoiceNumber,
          ),
        },
      },
      { status: 409 },
    );
  }

  const body = await req.json().catch(() => null);
  const staff = await staffForRestaurant(tenant.id, COLLECTOR_ROLES);
  const role = staff?.user?.role;
  const actor: MemoryActor = !staff
    ? "diner"
    : (BILLING_CUSTOMER_WRITE_ROLES as readonly string[]).includes(role ?? "")
      ? "manager"
      : "assistant";

  // Dos formas de pedir: con los datos escritos, o "Usar estos datos" (un
  // cliente guardado que el comensal sólo vio enmascarado).
  let fields: InvoiceRequestFields;
  let typed: z.infer<typeof typedSchema> | null = null;
  let savedCustomerId: string | null = null;
  const saved = body && typeof body === "object" && "savedCustomerToken" in body ? savedSchema.safeParse(body) : null;
  if (saved) {
    if (!saved.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const consumed = await consumeLookupToken(saved.data.savedCustomerToken, tenant.id, order.id);
    if (!consumed.ok) return NextResponse.json({ error: consumed.error }, { status: 409 });
    const c = consumed.customer;
    // Lo guardado se valida igual que lo escrito antes de emitir. Y tiene
    // que ser el documento que el comensal escribió.
    const validated = validateInvoiceFields({
      customerName: c.customerName,
      docType: c.docType,
      docNumber: c.docNumber,
      address: c.address,
      city: c.city,
      department: c.department,
      email: c.email,
      // Los adicionales guardados viajan también (la factura les llega a
      // todos); uno que hoy no pase la validación se descarta, no frena.
      ccEmails: storedExtraEmails(c.email, c.ccEmails),
    });
    const typedDoc = normalizeCustomerDocument(saved.data.docType, saved.data.docNumber);
    if (!validated.ok || !typedDoc.ok || saved.data.docType !== validated.fields.docType || typedDoc.docNumber !== validated.fields.docNumber) {
      return NextResponse.json({ error: "saved_customer_invalid" }, { status: 409 });
    }
    fields = validated.fields;
    savedCustomerId = c.id;
  } else {
    const parsed = typedSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const validated = validateInvoiceFields(parsed.data);
    if (!validated.ok) {
      return NextResponse.json(
        {
          error: "invalid",
          ...(validated.code ? { code: validated.code } : {}),
          ...(validated.index !== undefined ? { index: validated.index } : {}),
        },
        { status: 400 },
      );
    }
    fields = validated.fields;
    typed = parsed.data;
  }
  // Armada con un cliente guardado por alguien que no es personal: a él se
  // le muestra enmascarada (ver `invoiceSummaryFor`).
  const fromSavedCustomer = !!savedCustomerId && !staff;

  const data = {
    customerName: fields.customerName,
    docType: fields.docType,
    docNumber: fields.docNumber,
    address: fields.address,
    city: fields.city,
    department: fields.department,
    email: fields.email,
    ccEmails: fields.ccEmails,
    placeId: typed?.placeId ?? null,
    rawComponents:
      typed?.rawComponents != null
        ? (typed.rawComponents as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    rememberCustomer: typed ? (typed.rememberCustomer ?? false) : null,
    fromSavedCustomer,
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
  // "Recordar mis datos": con datos escritos se crea/actualiza el cliente
  // guardado según quién pide; con "Usar estos datos" sólo queda constancia.
  if (typed) {
    await rememberInvoiceCustomer({
      restaurantId: tenant.id,
      orderId: order.id,
      actor,
      remember: typed.rememberCustomer ?? false,
      fields,
      ccEmailsProvided: typed.ccEmails != null,
    });
  } else if (savedCustomerId) {
    await auditSavedCustomerUse(tenant.id, order.id, savedCustomerId, actor);
  }

  // Factura nominativa ligada a un cliente de facturación existente (staff
  // en el checkout): se aplica su descuento comercial con el mecanismo del
  // descuento por comensal. La solicitud ya quedó guardada arriba; si el
  // descuento no aplica (cuenta con pagos, descuento mayor) se avisa. Sólo
  // con sesión de staff: desde el comensal nunca hay beneficios.
  let discount: ApplyCustomerDiscountResult | null = null;
  if (typed?.billingCustomerId && staff) {
    const customer = await db.billingCustomer.findFirst({
      where: { id: typed.billingCustomerId, restaurantId: tenant.id },
      select: { discountEnabled: true, discountBps: true },
    });
    if (customer) {
      discount = await db.$transaction((tx) => applyCustomerDiscount(tx, order.id, tenant.id, customer));
    }
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
    email: fields.email,
    customer: {
      name: fields.customerName,
      docType: fields.docType,
      docNumber: fields.docNumber,
      address: fields.address,
      city: fields.city,
      department: fields.department,
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
        email: inv.email ?? fields.email,
        // Los adicionales, sólo si el correo que sale es el de esta solicitud.
        cc: (inv.email ?? fields.email) === fields.email ? fields.ccEmails : [],
        locale: inv.locale,
      },
      firstIssuance: !inv.alreadyIssued,
      emailJustProvided: inv.alreadyIssued && !inv.email,
    });
  }

  // Con un cliente guardado, el comensal no recibe lo que no escribió: ni el
  // nombre y el correo completos, ni el enlace de la factura (que los trae).
  return NextResponse.json({
    ok: true,
    request: fromSavedCustomer
      ? { id: request.id, ...invoiceSummaryFor({ ...request, status: request.status }, false) }
      : request,
    replaced: !!existing,
    invoiceUrl: inv.ok && !fromSavedCustomer ? inv.invoiceUrl : null,
    // El cliente muestra "te la enviamos apenas se confirme el pago" en vez
    // del botón de imprimir.
    deferred: !inv.ok && inv.error === "order_not_paid",
    // Ya emitida y enviada al correo guardado: el comensal ve "te la
    // enviamos a ju***@gm***.com".
    sentToSaved: fromSavedCustomer && inv.ok,
    discount,
  });
}

export const POST = secureApi(POSTHandler);
