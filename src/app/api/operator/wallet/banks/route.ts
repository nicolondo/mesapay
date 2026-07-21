import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { kushkiFetch } from "@/lib/payments/kushki/client";

export const dynamic = "force-dynamic";

/**
 * Lista de bancos destino para dispersiones (Transfer Out bankList de
 * Kushki), para el dropdown de "Transferir a otra cuenta".
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
    return NextResponse.json({ error: "no_restaurant" }, { status: 400 });
  }
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { kushkiPublicKey: true, kushkiMode: true },
  });
  if (!tenant?.kushkiPublicKey) {
    return NextResponse.json({ error: "not_onboarded" }, { status: 409 });
  }
  try {
    const resp = await kushkiFetch<
      Array<{ code?: string; id?: string; name?: string }>
    >(`/payouts/transfer/v1/bankList`, {
      method: "GET",
      auth: { kind: "submerchant_public", publicKey: tenant.kushkiPublicKey },
      mode: await getRestaurantKushkiMode(tenant),
    });
    const banks = (Array.isArray(resp) ? resp : [])
      .map((b) => ({ id: String(b.code ?? b.id ?? ""), name: b.name ?? "" }))
      .filter((b) => b.id && b.name);
    return NextResponse.json({ banks });
  } catch (err) {
    return NextResponse.json(
      {
        error: "banks_failed",
        message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      },
      { status: 502 },
    );
  }
}
