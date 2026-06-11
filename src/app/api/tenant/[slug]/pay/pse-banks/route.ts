import { NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getPaymentProvider } from "@/lib/payments";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";

/**
 * Lista los bancos PSE soportados. El front lo usa para armar el
 * dropdown del sheet de PSE. La lista es global a Kushki (no per-
 * merchant) — la cacheamos in-memory por 1h para no pegar a la API
 * en cada checkout.
 */

export const dynamic = "force-dynamic";

type CachedBanks = {
  fetchedAt: number;
  banks: { code: string; name: string }[];
};
let cached: CachedBanks | null = null;
const TTL_MS = 60 * 60 * 1000;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  // Necesitamos el publicKey del sub-merchant porque el bank list
  // endpoint de Kushki usa header Public-Merchant-Id.
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: {
      id: true,
      kushkiPublicKey: true,
      kushkiOnboardingStatus: true,
      kushkiMode: true,
    },
  });
  if (!tenant) {
    return NextResponse.json({ error: "unknown tenant" }, { status: 404 });
  }
  if (tenant.kushkiOnboardingStatus !== "active") {
    const t = await getTranslations("pay");
    return NextResponse.json(
      { error: "pse_not_available", message: t("errPseNotAvailable") },
      { status: 400 },
    );
  }

  const now = Date.now();
  if (cached && now - cached.fetchedAt < TTL_MS) {
    return NextResponse.json({ banks: cached.banks });
  }
  try {
    // Mock acepta cualquier string como publicKey. Live exige uno real.
    const publicKey = tenant.kushkiPublicKey ?? "mock_public_key";
    const provider = await getPaymentProvider(
      await getRestaurantKushkiMode(tenant),
    );
    const banks = await provider.listPseBanks(publicKey);
    cached = { fetchedAt: now, banks };
    return NextResponse.json({ banks });
  } catch (err) {
    console.error("[pse-banks]", err);
    // Si Kushki está caído devolvemos la cache previa si existe
    if (cached) return NextResponse.json({ banks: cached.banks });
    const t = await getTranslations("pay");
    return NextResponse.json(
      { error: "provider_error", message: t("errBanksLoad") },
      { status: 502 },
    );
  }
}
