import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { TerminalWait } from "./TerminalWait";

export const dynamic = "force-dynamic";

export default async function TerminalPendingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; orderId: string }>;
  searchParams: Promise<{ pid?: string }>;
}) {
  const { slug, orderId } = await params;
  const { pid } = await searchParams;

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { restaurant: true, table: true },
  });
  if (!order || order.restaurant.slug !== slug) notFound();

  const payment = pid
    ? await db.payment.findUnique({ where: { id: pid } })
    : null;
  if (!payment || payment.orderId !== order.id) notFound();
  // Aceptamos ambos métodos de datáfono: el cloud-pushed de Kushki
  // (kushki_card_terminal) y el datáfono propio del comercio
  // (external_terminal). El waiting screen es el mismo en ambos —
  // sólo cambia quién settlea (Kushki webhook vs mesero manualmente
  // desde Salón).
  if (
    payment.method !== "kushki_card_terminal" &&
    payment.method !== "external_terminal"
  ) {
    notFound();
  }

  return (
    <TerminalWait
      tenantSlug={slug}
      tenantName={order.restaurant.name}
      locationLabel={
        order.restaurant.serviceMode === "counter"
          ? "Mostrador"
          : `Mesa ${order.table.number}`
      }
      orderId={order.id}
      paymentId={payment.id}
      // payment.amountCents ya es el TOTAL (food + tip) — no hay que
      // sumar tipCents de nuevo o se duplica la propina en pantalla.
      amountCents={payment.amountCents}
      initialStatus={payment.status}
    />
  );
}
