import { secureApi } from "@/lib/secureApi";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { issueSimpleInvoice, sendSimpleInvoiceEmail } from "@/lib/simpleInvoice";

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
 * `issueRequestedInvoiceOnPaid` emite y envía cuando el cobro se confirma.
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
    select: { id: true },
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

  if (result.alreadyIssued) {
    return NextResponse.json({
      ok: true,
      alreadyIssued: true,
      invoiceId: result.invoiceId,
      invoiceUrl: result.invoiceUrl,
    });
  }

  // Fire-and-forget del correo — no bloqueamos la respuesta. La factura ya
  // existe y el link es válido aun si el correo demora o falla. Solo si hay
  // correo.
  if (result.email) {
    void sendSimpleInvoiceEmail({
      invoiceId: result.invoiceId,
      snapshot: result.snapshot,
      invoiceNumber: result.invoiceNumber,
      invoiceUrl: result.invoiceUrl,
      email: result.email,
      locale: result.locale,
    });
  }

  return NextResponse.json({
    ok: true,
    invoiceId: result.invoiceId,
    invoiceUrl: result.invoiceUrl,
  });
}

export const POST = secureApi(POSTHandler);
