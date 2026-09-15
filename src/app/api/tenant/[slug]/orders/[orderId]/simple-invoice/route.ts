import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { issueSimpleInvoice } from "@/lib/simpleInvoice";
import { deliverInvoiceEmail } from "@/lib/invoiceDelivery";

const bodySchema = z.object({
  // Correo OPCIONAL: vacío/ausente = solo se genera para imprimir/descargar
  // (no se envía nada). Con correo válido, además se envía.
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z
      .string()
      .email("Email inválido")
      .transform((s) => s.toLowerCase().trim())
      .optional(),
  ),
});

/**
 * Emisión de factura simple — tirilla POS (consumidor final) para imprimir
 * y/o enviar por correo. La numeración + snapshot viven en el helper
 * `issueSimpleInvoice` (fuente única, compartida con la factura personalizada).
 *
 * No requiere auth — el cliente está pagando (o acaba de pagar) y eligió
 * mandarse la factura. La barrera de que la orden esté paga vive en el helper.
 *
 * Se puede pedir ANTES de pagar (es lo que hace el checkout). En ese caso no
 * hay nada que emitir todavía, así que guardamos la intención en
 * `Order.simpleInvoiceEmail` y respondemos `deferred: true`;
 * `issueInvoiceOnPaid` emite y envía cuando el cobro se confirma.
 * Ojo: sin pago no hay tirilla que imprimir, así que en ese camino el correo
 * deja de ser opcional — sin él no habría nada que hacer después.
 */
async function POSTHandler(
  req: Request,
  { params }: { params: Promise<{ slug: string; orderId: string }> },
) {
  const { slug, orderId } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: { id: true, enabledModules: true },
  });
  if (!tenant) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    // Sin `message`: el texto que ve el comensal lo pone el cliente desde su
    // catálogo i18n (mandarlo desde acá lo dejaba en español para todos).
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const result = await issueSimpleInvoice({
    tenantId: tenant.id,
    orderId,
    email: parsed.data.email ?? null,
  });
  if (!result.ok) {
    if (result.error === "order_not_paid") {
      // Pedida durante el checkout: guardamos a dónde mandarla y salimos.
      // El `updateMany` va acotado por restaurantId para no escribir sobre la
      // orden de otro comercio si alguien juega con el slug.
      if (!parsed.data.email) {
        return NextResponse.json({ error: "email_required" }, { status: 400 });
      }
      const touched = await db.order.updateMany({
        where: { id: orderId, restaurantId: tenant.id },
        data: { simpleInvoiceEmail: parsed.data.email },
      });
      if (touched.count === 0) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return NextResponse.json({ ok: true, deferred: true });
    }
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Con facturación electrónica la tirilla se emite AL PAGAR, así que
  // cuando el comensal llega acá con su correo la factura ya existe:
  // `alreadyIssued` es el caso normal, no la excepción. Antes este camino
  // devolvía sin guardar el correo en ningún lado y el comensal se quedaba
  // sin nada — ni comprobante ni factura electrónica, que después no
  // encontraba destinatario. Ahora el correo se persiste (en la tirilla si
  // no tenía, y en la orden, que es lo que lee la factura electrónica) y se
  // decide el envío con la misma regla que al pagar.
  const providedEmail = parsed.data.email ?? null;
  const emailJustProvided =
    result.alreadyIssued && !!providedEmail && !result.email;
  if (emailJustProvided) {
    await db.$transaction([
      db.simpleInvoice.updateMany({
        where: { id: result.invoiceId, email: null },
        data: { email: providedEmail },
      }),
      db.order.updateMany({
        where: { id: orderId, restaurantId: tenant.id },
        data: { simpleInvoiceEmail: providedEmail },
      }),
    ]);
  }

  // Fire-and-forget del correo — no bloqueamos la respuesta. Qué correo
  // (comprobante vs. factura electrónica) lo decide invoiceDelivery.ts:
  // con `einvoicing` activo NUNCA sale el comprobante.
  void deliverInvoiceEmail({
    tenant: { id: tenant.id, enabledModules: tenant.enabledModules },
    invoice: {
      invoiceId: result.invoiceId,
      invoiceNumber: result.invoiceNumber,
      invoiceUrl: result.invoiceUrl,
      snapshot: result.snapshot,
      email: result.email ?? providedEmail,
      locale: result.locale,
    },
    firstIssuance: !result.alreadyIssued,
    emailJustProvided,
  });

  if (result.alreadyIssued) {
    return NextResponse.json({
      ok: true,
      alreadyIssued: true,
      invoiceId: result.invoiceId,
      invoiceUrl: result.invoiceUrl,
    });
  }

  return NextResponse.json({
    ok: true,
    invoiceId: result.invoiceId,
    invoiceUrl: result.invoiceUrl,
  });
}

export const POST = secureApi(POSTHandler);
