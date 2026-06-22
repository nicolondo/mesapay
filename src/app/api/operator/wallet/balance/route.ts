import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import {
  getPaymentProvider,
  getRestaurantPrivateKey,
} from "@/lib/payments";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";

/**
 * Returns the live balance from the provider. We don't cache here — the
 * UI refreshes infrequently, and the wallet page is shown to one human at a
 * time. If we ever build a public-facing balance widget, add a 30s LRU.
 */
export async function GET() {
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
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { kushkiMerchantId: true, kushkiMode: true, country: true },
  });
  if (!tenant?.kushkiMerchantId) {
    return NextResponse.json(
      {
        availableCents: 0,
        pendingCents: 0,
        currency: await getCurrencyForCountry(tenant?.country),
        onboarded: false,
      },
    );
  }
  const privateKey = await getRestaurantPrivateKey(restaurantId);
  if (!privateKey) {
    return NextResponse.json({ error: "credentials_missing" }, { status: 500 });
  }
  try {
    const provider = await getPaymentProvider(
      await getRestaurantKushkiMode(tenant),
    );
    const balance = await provider.getBalance(privateKey);
    return NextResponse.json({
      availableCents: balance.availableCents,
      pendingCents: balance.pendingCents,
      currency: balance.currency,
      onboarded: true,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "balance_failed",
        message: err instanceof Error ? err.message : "unknown",
      },
      { status: 502 },
    );
  }
}
