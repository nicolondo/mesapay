import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { sendEmail } from "@/lib/mailer";
import { renderInvoiceEmail, type InvoiceSnapshot } from "@/lib/invoice";
import { orderTaxTotals } from "@/lib/salesTax";

/** Datos del cliente para una factura personalizada. */
export type InvoiceCustomer = {
  name: string;
  docType: string; // CC | CE | NIT | PA
  docNumber: string;
  address: string;
  city: string;
  department: string;
};

export type IssueSimpleInvoiceResult =
  | {
      ok: true;
      invoiceId: string;
      invoiceUrl: string;
      invoiceNumber: number;
      snapshot: InvoiceSnapshot;
      email: string | null;
      locale: string | null;
      alreadyIssued: boolean;
    }
  | { ok: false; error: "not_found" | "order_not_paid" };

export function invoiceUrlFor(id: string): string {
  const base = env.APP_PUBLIC_BASE_URL ?? "https://mesapay.co";
  return `${base.replace(/\/$/, "")}/factura/${id}`;
}

/**
 * Emite (o devuelve, idempotente) la factura simple imprimible de una orden
 * pagada. Fuente ÚNICA de la numeración + snapshot — la usan la tirilla
 * genérica (consumidor final) y la factura personalizada (con datos del
 * cliente). El envío de correo lo hace el caller (varía por flujo).
 */
export async function issueSimpleInvoice(opts: {
  tenantId: string;
  orderId: string;
  email?: string | null;
  customer?: InvoiceCustomer | null;
}): Promise<IssueSimpleInvoiceResult> {
  const order = await db.order.findUnique({
    where: { id: opts.orderId },
    include: {
      table: true,
      // Mismo criterio de "item vivo" que `syncOrderSubtotalFromLiveItems`:
      // sin cancelar Y sin ronda cancelada. Antes sólo miraba `cancelledAt`,
      // así que los platos de una ronda cancelada se imprimían en la tirilla
      // aunque el subtotal (que sí los excluye) no los cobrara.
      items: {
        where: {
          cancelledAt: null,
          OR: [{ roundId: null }, { round: { status: { not: "cancelled" } } }],
        },
        orderBy: { id: "asc" },
      },
      simpleInvoice: true,
    },
  });
  if (!order || order.restaurantId !== opts.tenantId) {
    return { ok: false, error: "not_found" };
  }
  if (order.status !== "paid") {
    return { ok: false, error: "order_not_paid" };
  }

  // Idempotencia — ya emitida antes: devolvemos esa (no re-numeramos).
  if (order.simpleInvoice) {
    return {
      ok: true,
      invoiceId: order.simpleInvoice.id,
      invoiceUrl: invoiceUrlFor(order.simpleInvoice.id),
      invoiceNumber: order.simpleInvoice.invoiceNumber,
      snapshot: order.simpleInvoice.snapshot as unknown as InvoiceSnapshot,
      email: order.simpleInvoice.email,
      locale: order.locale,
      alreadyIssued: true,
    };
  }

  // Atomic increment del consecutivo. El default es 1 — la primera factura
  // del comercio recibe número 1.
  const r = await db.restaurant.update({
    where: { id: opts.tenantId },
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
  const invoiceNumber = r.invoiceNextNumber - 1;

  // Desglose por tipo del impuesto que las LÍNEAS LIBRES suman encima. Se pasa
  // el comercio en "none" a propósito: así `byKind` cuenta sólo lo que se suma
  // (cada línea bajo SU tipo) y deja afuera el impuesto embebido de los platos
  // del menú, que ya está dentro del subtotal y no se cobra aparte.
  const taxed = orderTaxTotals(
    order.items.map((i) => ({
      amountCents: i.priceCentsSnapshot * i.qty,
      taxKind: i.taxKind,
      taxPct: i.taxPct,
    })),
    { kind: "none", pct: 0 },
  );

  const snapshot: InvoiceSnapshot = {
    restaurantName: r.name,
    logoUrl: r.logoUrl,
    legalName: r.legalName,
    taxId: r.taxId,
    legalAddress: r.legalAddress,
    legalCity: r.legalCity,
    legalPhone: r.legalPhone,
    dianResolution: r.dianResolution,
    dianResolutionFrom: r.dianResolutionFrom,
    dianResolutionTo: r.dianResolutionTo,
    dianResolutionDate: r.dianResolutionDate?.toISOString() ?? null,
    invoicePrefix: r.invoicePrefix,
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
    taxCents: order.taxCents,
    taxByKind: taxed.byKind,
    discountCents: order.discountCents,
    discountPct: order.discountPct,
    tipCents: order.tipCents,
    totalCents: order.totalCents,
    customer: opts.customer ?? null,
  };

  const inv = await db.simpleInvoice.create({
    data: {
      restaurantId: opts.tenantId,
      orderId: order.id,
      email: opts.email ?? null,
      invoiceNumber,
      snapshot: snapshot as unknown as object,
      totalCents: order.totalCents,
    },
  });

  return {
    ok: true,
    invoiceId: inv.id,
    invoiceUrl: invoiceUrlFor(inv.id),
    invoiceNumber,
    snapshot,
    email: opts.email ?? null,
    locale: order.locale,
    alreadyIssued: false,
  };
}

/**
 * Compose "NOMBRE · MESAPAY <email@dominio>" usando el nombre del restaurante
 * + el address del MAIL_FROM global. null (caller cae al default) si el env no
 * tiene una address parseable o si el nombre queda vacío al sanitizar.
 * RFC 5322 prohíbe `<`, `>`, `"`, `,` en el display name — los stripeamos.
 */
function buildBrandedFrom(restaurantName: string): string | null {
  const raw = restaurantName.trim();
  if (!raw) return null;
  const safeName = raw.replace(/[<>"\\,]/g, "").trim().slice(0, 100);
  if (!safeName) return null;
  const mailFrom = process.env.MAIL_FROM ?? "";
  const m = mailFrom.match(/<([^>]+)>/) ?? mailFrom.match(/(\S+@\S+)/);
  const address = m?.[1]?.trim();
  if (!address || !/.+@.+/.test(address)) return null;
  return `${safeName} · MESAPAY <${address}>`;
}

/**
 * Envía la factura simple por correo (best-effort). Marca emailedAt/emailError
 * en la fila. Fire-and-forget desde el caller (no bloquea la respuesta).
 */
export async function sendSimpleInvoiceEmail(opts: {
  invoiceId: string;
  snapshot: InvoiceSnapshot;
  invoiceNumber: number;
  invoiceUrl: string;
  email: string;
  locale: string | null;
}): Promise<void> {
  try {
    const { subject, html, text } = await renderInvoiceEmail({
      snapshot: opts.snapshot,
      invoiceNumber: opts.invoiceNumber,
      invoiceUrl: opts.invoiceUrl,
      locale: opts.locale ?? undefined,
    });
    const from = buildBrandedFrom(opts.snapshot.restaurantName);
    const ok = await sendEmail({
      to: opts.email,
      subject,
      html,
      text,
      ...(from && { from }),
    });
    await db.simpleInvoice.update({
      where: { id: opts.invoiceId },
      data: {
        emailedAt: ok ? new Date() : null,
        emailError: ok ? null : "send_failed",
      },
    });
  } catch (err) {
    console.error("[simple-invoice] email failed", err);
    await db.simpleInvoice
      .update({
        where: { id: opts.invoiceId },
        data: { emailError: String(err).slice(0, 200) },
      })
      .catch(() => undefined);
  }
}
