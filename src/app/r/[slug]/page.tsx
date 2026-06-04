import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { resolveReservationConfig } from "@/lib/reservations";
import { getRestaurantKushkiMode } from "@/lib/platformConfig";
import { getPaymentProvider } from "@/lib/payments";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";
import { ReservarClient } from "./ReservarClient";

export const dynamic = "force-dynamic";

/**
 * Página pública de reservas — el diner llega acá desde un link
 * directo o desde Google Maps (sitio web del restaurante). Elige
 * fecha + tamaño de grupo, ve los horarios disponibles, elige uno +
 * mesa, completa sus datos y reserva.
 *
 * source=google viene en el query cuando llega desde el deep link de
 * Maps — lo pasamos al client para taggear la reserva y medir
 * conversión por canal.
 */
export default async function ReservarPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ source?: string }>;
}) {
  const { slug } = await params;
  const { source } = await searchParams;

  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: {
      id: true,
      name: true,
      logoUrl: true,
      reservationsEnabled: true,
      reservationConfig: true,
      legalCity: true,
      kushkiPublicKey: true,
      kushkiOnboardingStatus: true,
      kushkiMode: true,
    },
  });
  if (!tenant) return notFound();
  // Modo efectivo del comercio (override propio o global) → host de Kushki.
  const kushkiMode = await getRestaurantKushkiMode(tenant);

  if (!tenant.reservationsEnabled) {
    const t = await getTranslations("reservar");
    return (
      <main className="min-h-dvh flex items-center justify-center px-6 bg-bone text-ink">
        <div className="text-center max-w-sm">
          <div className="font-display text-2xl mb-2">{t("closedTitle")}</div>
          <p className="text-sm text-muted">
            {t("closedBody", { name: tenant.name })}
          </p>
          <div className="mt-6 flex justify-center">
            <LocaleSwitcher />
          </div>
        </div>
      </main>
    );
  }

  const config = resolveReservationConfig(tenant.reservationConfig);

  // Pre-cargamos la lista de bancos PSE en el server (cacheada 1h) para
  // que el dropdown del depósito por PSE salga instantáneo — sin el
  // "Cargando bancos…". Mismo patrón que el checkout de pedidos. Sólo
  // cuando el comercio está onboardeado; best-effort, no bloquea la
  // página si falla.
  let pseBanks: { code: string; name: string }[] = [];
  if (tenant.kushkiOnboardingStatus === "active" && tenant.kushkiPublicKey) {
    try {
      const provider = await getPaymentProvider(kushkiMode);
      pseBanks = await provider.listPseBanks(tenant.kushkiPublicKey);
    } catch (err) {
      console.error("[reservar] prefetch pse banks", err);
    }
  }

  return (
    <ReservarClient
      tenantSlug={slug}
      tenantName={tenant.name}
      logoUrl={tenant.logoUrl}
      city={tenant.legalCity}
      slotMinutes={config.slotMinutes}
      maxAdvanceDays={config.maxAdvanceDays}
      policyNote={config.policyNote ?? null}
      source={source === "google" ? "google_maps" : "direct"}
      kushkiPublicKey={tenant.kushkiPublicKey}
      kushkiMode={kushkiMode}
      pseBanks={pseBanks}
    />
  );
}
