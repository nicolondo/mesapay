import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import {
  getPaymentProvider,
  getRestaurantPrivateKey,
} from "@/lib/payments";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
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
    select: {
      kushkiMerchantId: true,
      kushkiPublicKey: true,
      bankInfo: true,
      kushkiMode: true,
      country: true,
    },
  });
  if (!tenant?.kushkiMerchantId || !tenant.bankInfo) {
    return NextResponse.json({ error: "not_onboarded" }, { status: 409 });
  }
  if (!tenant.kushkiPublicKey) {
    // Transfer Out tokeniza con la clave PÚBLICA (igual que los cobros).
    return NextResponse.json({ error: "credentials_missing" }, { status: 500 });
  }
  const privateKey = await getRestaurantPrivateKey(restaurantId);
  if (!privateKey) {
    return NextResponse.json({ error: "credentials_missing" }, { status: 500 });
  }
  const bankInfo = tenant.bankInfo as unknown as BankInfo;

  try {
    const provider = await getPaymentProvider(
      await getRestaurantKushkiMode(tenant),
    );
    const result = await provider.disburse({
      merchantId: privateKey,
      publicKey: tenant.kushkiPublicKey,
      amount: { amountCents: parsed.data.amountCents, currency: await getCurrencyForCountry(tenant.country) },
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
