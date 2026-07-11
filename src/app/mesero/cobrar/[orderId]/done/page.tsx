import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { InvoiceRequestPanel } from "@/app/t/[slug]/pay/[orderId]/done/InvoiceRequestPanel";

export const dynamic = "force-dynamic";

/**
 * "Cobro realizado" del MESERO — vive bajo /mesero/ para quedar DENTRO de
 * la PWA (con su bottom nav Salón/Cobros/Mesas). Acá el mesero ofrece la
 * factura DESPUÉS del pago (genérica / personalizada). Antes se rebotaba a
 * /t/[slug]/…/done, que está fuera del scope de la PWA y ocultaba el nav.
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
      totalCents: true,
      subtotalCents: true,
      restaurant: { select: { slug: true } },
    },
  });
  if (!order) return notFound();
  if (
    role === "mesero" &&
    session.user.restaurantId &&
    session.user.restaurantId !== order.restaurantId
  ) {
    return notFound();
  }

  const existing = await db.invoiceRequest.findFirst({
    where: { orderId },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      customerName: true,
      docType: true,
      docNumber: true,
      email: true,
      address: true,
      city: true,
      department: true,
    },
  });

  const t = await getTranslations("done");

  return (
    <div className="px-5 py-6 space-y-4 max-w-lg mx-auto w-full">
      <div className="rounded-2xl border border-ok/30 bg-ok/10 p-4 flex items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-ok">
            {t("opChargeDone")}
          </div>
          <div className="font-display text-2xl tabular mt-0.5">
            {fmtCOP(Math.max(order.totalCents, order.subtotalCents))}
          </div>
        </div>
        <Link
          href="/mesero/mesas"
          className="shrink-0 h-9 px-4 rounded-full bg-ink text-bone text-xs font-medium inline-flex items-center"
        >
          {t("opBackToTables")}
        </Link>
      </div>

      <InvoiceRequestPanel
        tenantSlug={order.restaurant.slug}
        orderId={orderId}
        existing={existing}
        operatorMode
      />
    </div>
  );
}
