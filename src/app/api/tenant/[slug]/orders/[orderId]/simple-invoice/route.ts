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
 * No requiere auth — el cliente acaba de pagar y eligió mandarse la factura.
 * La validación de que la orden esté paga (en el helper) es la barrera.
 */
export async function POST(
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
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: "invalid", message: first?.message ?? "Email inválido" },
      { status: 400 },
    );
  }

  const result = await issueSimpleInvoice({
    tenantId: tenant.id,
    orderId,
    email: parsed.data.email ?? null,
  });
  if (!result.ok) {
    if (result.error === "order_not_paid") {
      return NextResponse.json(
        {
          error: "order_not_paid",
          message:
            "Solo puedes pedir factura una vez confirmado el pago de la orden.",
        },
        { status: 409 },
      );
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
