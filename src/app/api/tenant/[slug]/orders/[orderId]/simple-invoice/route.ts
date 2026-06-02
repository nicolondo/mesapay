import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/mailer";
import {
  renderInvoiceEmail,
  type InvoiceSnapshot,
} from "@/lib/invoice";

const bodySchema = z.object({
  email: z
    .string()
    .email("Email inválido")
    .transform((s) => s.toLowerCase().trim()),
});

/**
 * Emisión de factura simple — tirilla POS enviada por correo al
 * cliente que no requiere factura con razón social específica.
 *
 * Flujo:
 *   1. Validamos email + que la orden esté paga y del tenant.
 *   2. Idempotencia: si ya existe SimpleInvoice para esta orden,
 *      la retornamos (no re-asignamos consecutivo).
 *   3. Atomic increment del Restaurant.invoiceNextNumber.
 *   4. Snapshot completo del estado del comercio + de la orden.
 *   5. Persistimos SimpleInvoice con snapshot + total + email.
 *   6. Fire-and-forget del email (best-effort; si falla quedamos
 *      con emailedAt=null + emailError para reintento manual).
 *
 * No requiere auth — el cliente acaba de pagar y eligió mandarse
 * la factura. La validación de que la orden esté paga es la barrera.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string; orderId: string }> },
) {
  const { slug, orderId } = await params;
  const tenant = await db.restaurant.findUnique({ where: { slug } });
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

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      table: true,
      items: {
        where: { cancelledAt: null },
        orderBy: { id: "asc" },
      },
      simpleInvoice: true,
    },
  });
  if (!order || order.restaurantId !== tenant.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (order.status !== "paid") {
    return NextResponse.json(
      {
        error: "order_not_paid",
        message:
          "Solo puedes pedir factura una vez confirmado el pago de la orden.",
      },
      { status: 409 },
    );
  }

  // Idempotencia — ya emitida antes, devolvemos esa.
  if (order.simpleInvoice) {
    return NextResponse.json({
      ok: true,
      alreadyIssued: true,
      invoiceId: order.simpleInvoice.id,
      invoiceUrl: invoiceUrlFor(order.simpleInvoice.id),
    });
  }

  // Atomic increment del consecutivo. El default es 1 — la primera
  // factura del comercio recibe número 1.
  const updated = await db.restaurant.update({
    where: { id: tenant.id },
    data: { invoiceNextNumber: { increment: 1 } },
    select: {
      invoiceNextNumber: true,
      name: true,
      logoUrl: true,
      legalName: true,
      taxId: true,
      legalAddress: true,
      legalCity: true,
      legalPhone: true,
      dianResolution: true,
      dianResolutionFrom: true,
      dianResolutionTo: true,
      dianResolutionDate: true,
      invoicePrefix: true,
    },
  });
  // El increment devolvió el VALOR DESPUÉS de incrementar, así que
  // restamos 1 para obtener el número que asignamos a esta factura.
  const invoiceNumber = updated.invoiceNextNumber - 1;

  const snapshot: InvoiceSnapshot = {
    restaurantName: updated.name,
    logoUrl: updated.logoUrl,
    legalName: updated.legalName,
    taxId: updated.taxId,
    legalAddress: updated.legalAddress,
    legalCity: updated.legalCity,
    legalPhone: updated.legalPhone,
    dianResolution: updated.dianResolution,
    dianResolutionFrom: updated.dianResolutionFrom,
    dianResolutionTo: updated.dianResolutionTo,
    dianResolutionDate: updated.dianResolutionDate?.toISOString() ?? null,
    invoicePrefix: updated.invoicePrefix,
    shortCode: order.shortCode,
    tableLabel: order.table
      ? `Mesa ${order.table.number}${order.table.label ? ` · ${order.table.label}` : ""}`
      : "Mostrador",
    paidAtIso: (order.paidAt ?? new Date()).toISOString(),
    items: order.items.map((i) => ({
      qty: i.qty,
      name: i.nameSnapshot,
      priceCents: i.priceCentsSnapshot,
    })),
    subtotalCents: order.subtotalCents,
    tipCents: order.tipCents,
    totalCents: order.totalCents,
  };

  const inv = await db.simpleInvoice.create({
    data: {
      restaurantId: tenant.id,
      orderId: order.id,
      email: parsed.data.email,
      invoiceNumber,
      snapshot: snapshot as unknown as object,
      totalCents: order.totalCents,
    },
  });

  // Fire-and-forget email — no bloqueamos la respuesta. La factura
  // ya existe en DB y el link es válido aun si el correo demora o
  // falla; el cliente puede pedir reenvío si no llega.
  void (async () => {
    try {
      const { subject, html, text } = await renderInvoiceEmail({
        snapshot,
        invoiceNumber,
        invoiceUrl: invoiceUrlFor(inv.id),
        locale: order.locale,
      });
      // Compose un From que muestre el nombre del restaurante para
      // que el cliente reconozca de quién viene en la bandeja de
      // entrada: "DELIRIO RESTAURANTE · MESAPAY <facturas@mesapay.co>".
      // Cae al MAIL_FROM del env si por alguna razón no podemos
      // construirlo (sin email-address parseable o sin restaurant.name).
      const from = buildBrandedFrom(snapshot.restaurantName);
      const ok = await sendEmail({
        to: parsed.data.email,
        subject,
        html,
        text,
        ...(from && { from }),
      });
      await db.simpleInvoice.update({
        where: { id: inv.id },
        data: {
          emailedAt: ok ? new Date() : null,
          emailError: ok ? null : "send_failed",
        },
      });
    } catch (err) {
      console.error("[simple-invoice] email failed", err);
      await db.simpleInvoice
        .update({
          where: { id: inv.id },
          data: { emailError: String(err).slice(0, 200) },
        })
        .catch(() => undefined);
    }
  })();

  return NextResponse.json({
    ok: true,
    invoiceId: inv.id,
    invoiceUrl: invoiceUrlFor(inv.id),
  });
}

function invoiceUrlFor(id: string): string {
  const base = env.APP_PUBLIC_BASE_URL ?? "https://mesapay.co";
  return `${base.replace(/\/$/, "")}/factura/${id}`;
}

/**
 * Compose "NOMBRE · MESAPAY <email@dominio>" usando el nombre del
 * restaurante + el address del MAIL_FROM global. Devuelve null
 * (caller cae al default) si el env no tiene una address parseable
 * o si el nombre queda vacío al sanitizar.
 *
 * RFC 5322 prohíbe `<`, `>`, `"`, `,` en el display name — los
 * stripeamos para evitar que el email sea rechazado por Resend.
 */
function buildBrandedFrom(restaurantName: string): string | null {
  const raw = restaurantName.trim();
  if (!raw) return null;
  const safeName = raw.replace(/[<>"\\,]/g, "").trim().slice(0, 100);
  if (!safeName) return null;
  const mailFrom = process.env.MAIL_FROM ?? "";
  // Extrae el email de "Display Name <email@dominio>" o de
  // "email@dominio" suelto.
  const m = mailFrom.match(/<([^>]+)>/) ?? mailFrom.match(/(\S+@\S+)/);
  const address = m?.[1]?.trim();
  if (!address || !/.+@.+/.test(address)) return null;
  return `${safeName} · MESAPAY <${address}>`;
}
