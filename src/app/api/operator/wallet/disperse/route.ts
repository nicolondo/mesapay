import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  getPaymentProvider,
  getRestaurantPrivateKey,
} from "@/lib/payments";
import type { BankInfo } from "@/lib/payments";

const schema = z.object({
  amountCents: z.number().int().min(100),
});

export async function POST(req: Request) {
  const session = await auth();
  if (
    !session?.user ||
    (session.user.role !== "operator" && session.user.role !== "platform_admin")
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return NextResponse.json({ error: "no restaurant" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { kushkiMerchantId: true, bankInfo: true },
  });
  if (!tenant?.kushkiMerchantId || !tenant.bankInfo) {
    return NextResponse.json({ error: "not_onboarded" }, { status: 409 });
  }
  const privateKey = await getRestaurantPrivateKey(restaurantId);
  if (!privateKey) {
    return NextResponse.json({ error: "credentials_missing" }, { status: 500 });
  }
  const bankInfo = tenant.bankInfo as unknown as BankInfo;

  try {
    const result = await getPaymentProvider().disburse({
      merchantId: privateKey,
      amount: { amountCents: parsed.data.amountCents, currency: "COP" },
      bankInfo,
      reference: `mp-${Date.now()}`,
    });
    return NextResponse.json({
      ok: true,
      providerRef: result.providerRef,
      status: result.status,
      estimatedSettlementAt: result.estimatedSettlementAt?.toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "disperse_failed",
        message: err instanceof Error ? err.message : "unknown",
      },
      { status: 502 },
    );
  }
}
