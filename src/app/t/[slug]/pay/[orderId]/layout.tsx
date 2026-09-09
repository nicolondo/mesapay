import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { canAccessOrder } from "@/lib/guestAccess";
export default async function OrderAccessLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string; orderId: string }> }) {
  const { slug, orderId } = await params;
  const restaurant = await db.restaurant.findUnique({ where: { slug }, select: { id: true } });
  if (!restaurant || !await canAccessOrder(restaurant.id, orderId)) notFound();
  return children;
}
