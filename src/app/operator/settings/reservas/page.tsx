import Link from "next/link";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { resolveReservationConfig } from "@/lib/reservations";
import {
  resolveEnabledPaymentMethods,
  resolveDepositMethods,
  DEPOSIT_CAPABLE_SLUGS,
} from "@/lib/paymentMethods";
import { ReservasConfigClient } from "./ReservasConfigClient";

export const dynamic = "force-dynamic";

export default async function ReservasSettingsPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      slug: true,
      reservationsEnabled: true,
      reservationConfig: true,
      enabledPaymentMethods: true,
      reservationDepositMethods: true,
    },
  });
  if (!tenant) return <div className="p-6">Restaurante no encontrado.</div>;

  const enabledMethods = resolveEnabledPaymentMethods(
    tenant.enabledPaymentMethods,
  );
  const depositCapable = enabledMethods.filter((s) =>
    DEPOSIT_CAPABLE_SLUGS.includes(s),
  );
  const initialDepositMethods = resolveDepositMethods(
    tenant.reservationDepositMethods,
    enabledMethods,
  );

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="text-sm text-op-muted hover:underline"
      >
        ← Configuración
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">Reservas</div>
      <p className="text-sm text-op-muted mb-6">
        Permití que tus clientes aparten mesa desde un link. Definí los
        turnos en que recibís reservas, cuánto dura cada una y si se
        confirman solas o las aprobás vos.
      </p>

      <ReservasConfigClient
        tenantSlug={tenant.slug}
        initialEnabled={tenant.reservationsEnabled}
        initialConfig={resolveReservationConfig(tenant.reservationConfig)}
        depositCapable={depositCapable}
        initialDepositMethods={initialDepositMethods}
      />
    </div>
  );
}
