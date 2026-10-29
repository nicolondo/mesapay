import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { invoiceUrlFor } from "@/lib/simpleInvoice";
import { staffPrintAccessFor } from "@/lib/print/staffPrint";
import { InvoiceRequestPanel } from "@/app/t/[slug]/pay/[orderId]/done/InvoiceRequestPanel";
import { staffForRestaurant } from "@/lib/staffAccess";
import { outstandingSubtotalCents } from "@/lib/checkoutTax";

export const dynamic = "force-dynamic";

/**
 * "Cobro realizado" del MESERO — vive bajo /mesero/ para quedar DENTRO de
 * la PWA (con su bottom nav Salón/Cobros/Mesas). La factura ahora se pide
 * durante el cobro, así que acá queda su ESTADO (y una salida discreta si el
 * cliente cambió de opinión). Antes se rebotaba a /t/[slug]/…/done, que está
 * fuera del scope de la PWA y ocultaba el nav.
 */
export default async function MeseroCobradoPage({
  params,
}: {
  params: Promise<{ orderId: string }>;
}) {
  const { orderId } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect(`/signin?callbackUrl=/mesero/cobrar/${orderId}/done`);
  }
  const role = session.user.role;
  if (role !== "mesero" && role !== "operator" && role !== "platform_admin") {
    redirect("/");
  }

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      restaurantId: true,
      status: true,
      totalCents: true,
      subtotalCents: true,
      taxCents: true,
      discountCents: true,
      customerEmail: true,
      simpleInvoiceEmail: true,
      // La factura ya emitida (si la hay), para ofrecer imprimirla.
      simpleInvoice: { select: { id: true } },
      restaurant: { select: { slug: true } },
      payments: { where: { status: "approved" }, select: { amountCents: true, tipCents: true } },
    },
  });
  if (!order) return notFound();
  if (!await staffForRestaurant(order.restaurantId, ["mesero", "operator", "platform_admin"])) {
    return notFound();
  }

  const paidCents = order.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const paidTipCents = order.payments.reduce((sum, payment) => sum + payment.tipCents, 0);
  const outstandingCents = outstandingSubtotalCents(
    Math.max(0, order.subtotalCents + order.taxCents - order.discountCents),
    paidCents,
    paidTipCents,
  );
  const fullyPaid = order.status === "paid";
  const continueHref = role === "mesero"
    ? `/mesero/cobrar/${orderId}`
    : `/t/${order.restaurant.slug}/pay/${orderId}?op=1`;

  const existing = await db.invoiceRequest.findFirst({
    where: { orderId },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      customerName: true,
      docType: true,
      docNumber: true,
      email: true,
    },
  });

  const t = await getTranslations("done");

  return (
    <div className="px-5 py-6 space-y-4 max-w-lg mx-auto w-full">
      <div className="rounded-2xl border border-ok/30 bg-ok/10 p-4 flex items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-ok">
            {t(fullyPaid ? "opChargeDone" : "paymentReceived")}
          </div>
          <div className="font-display text-2xl tabular mt-0.5">
            {fmtCOP(paidCents)}
          </div>
        </div>
        <Link
          href="/mesero/mesas"
          className="shrink-0 h-9 px-4 rounded-full bg-ink text-bone text-xs font-medium inline-flex items-center"
        >
          {t("opBackToTables")}
        </Link>
      </div>

      {!fullyPaid && outstandingCents > 0 && (
        <div className="rounded-2xl border border-hairline bg-paper p-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs text-muted">{t("owed")}</div>
            <div className="font-display text-2xl tabular">{fmtCOP(outstandingCents)}</div>
          </div>
          <Link href={continueHref} className="shrink-0 h-10 px-4 rounded-full bg-ink text-bone text-sm font-medium inline-flex items-center">
            {t("payMore")}
          </Link>
        </div>
      )}

      {fullyPaid && <InvoiceRequestPanel
        tenantSlug={order.restaurant.slug}
        orderId={orderId}
        existing={existing}
        simpleRequestEmail={order.simpleInvoiceEmail}
        issuedInvoiceUrl={
          order.simpleInvoice ? invoiceUrlFor(order.simpleInvoice.id) : null
        }
        orderPaid={order.status === "paid"}
        prefillEmail={order.customerEmail}
        operatorMode
        // "Imprimir factura" sale por el agente (como las comandas); el
        // navegador, sólo si el local no tiene impresora de facturas.
        staffPrint={staffPrintAccessFor(role)}
      />}
    </div>
  );
}
