import Link from "next/link";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import {
  resolveTipPolicy,
  resolveShiftPolicy,
} from "@/lib/staffPolicies";
import { StaffPoliciesClient } from "./StaffPoliciesClient";

export const dynamic = "force-dynamic";

export default async function StaffPoliciesPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { tipPolicy: true, shiftPolicy: true },
  });
  if (!tenant) return <div className="p-6">Restaurante no encontrado.</div>;

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="text-sm text-op-muted hover:underline"
      >
        ← Configuración
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">Propinas y turnos</div>
      <p className="text-sm text-op-muted mb-6">
        Define cómo se reparten las propinas entre el staff y cómo se
        cuentan los turnos de cada mesero. Estos ajustes afectan los
        reportes y lo que cada mesero ve en su vista personal.
      </p>

      <StaffPoliciesClient
        initialTipPolicy={resolveTipPolicy(tenant.tipPolicy)}
        initialShiftPolicy={resolveShiftPolicy(tenant.shiftPolicy)}
      />
    </div>
  );
}
