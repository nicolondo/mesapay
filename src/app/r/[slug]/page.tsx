import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { resolveReservationConfig } from "@/lib/reservations";
import { getKushkiMode } from "@/lib/platformConfig";
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
    },
  });
  if (!tenant) return notFound();

  if (!tenant.reservationsEnabled) {
    return (
      <main className="min-h-dvh flex items-center justify-center px-6 bg-bone text-ink">
        <div className="text-center max-w-sm">
          <div className="font-display text-2xl mb-2">
            Reservas no disponibles
          </div>
          <p className="text-sm text-muted">
            {tenant.name} no está recibiendo reservas en línea por ahora.
          </p>
        </div>
      </main>
    );
  }

  const config = resolveReservationConfig(tenant.reservationConfig);

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
      kushkiMode={await getKushkiMode()}
    />
  );
}
