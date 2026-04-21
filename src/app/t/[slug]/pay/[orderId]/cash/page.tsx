import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { CashWait } from "./CashWait";

export const dynamic = "force-dynamic";

export default async function CashPendingPage({
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

  return (
    <CashWait
      tenantSlug={slug}
      tenantName={order.restaurant.name}
      tableNumber={order.table.number}
      orderId={order.id}
      paymentId={payment.id}
      amountCents={payment.amountCents}
      initialStatus={payment.status}
    />
  );
}
