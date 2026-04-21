import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; paymentId: string }> },
) {
  const { slug, paymentId } = await params;
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: { order: { include: { restaurant: true } } },
  });
  if (!payment || payment.order.restaurant.slug !== slug) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({
    id: payment.id,
    status: payment.status,
    amountCents: payment.amountCents,
    orderStatus: payment.order.status,
  });
}
