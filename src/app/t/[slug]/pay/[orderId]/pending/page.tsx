import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { canAccessOrder } from "@/lib/guestAccess";
import { PendingPayment } from "./PendingPayment";

export default async function Page({ params, searchParams }: {
  params: Promise<{ slug: string; orderId: string }>;
  searchParams: Promise<{ pid?: string }>;
}) {
  const { slug, orderId } = await params;
  const { pid } = await searchParams;
  const tenant = await db.restaurant.findUnique({ where: { slug }, select: { id: true } });
  if (!tenant || !pid || !await canAccessOrder(tenant.id, orderId)) notFound();
  const payment = await db.payment.findFirst({ where: { id: pid, orderId }, select: { id: true, order: { select: { orderType: true } } } });
  if (!payment) notFound();
  return <PendingPayment slug={slug} orderId={orderId} paymentId={payment.id} pickup={payment.order.orderType === "pickup"} />;
}
