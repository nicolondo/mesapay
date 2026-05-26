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
    select: {
      tipPolicy: true,
      shiftPolicy: true,
      walkoutDangerMinutes: true,
    },
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
      <div className="font-display text-3xl mt-2 mb-1">Políticas operativas</div>
      <p className="text-sm text-op-muted mb-6">
        Define cómo se reparten las propinas, cómo se cuentan los
        turnos y cuándo el sistema considera que una mesa está en
        riesgo de irse sin pagar.
      </p>

      <StaffPoliciesClient
        initialTipPolicy={resolveTipPolicy(tenant.tipPolicy)}
        initialShiftPolicy={resolveShiftPolicy(tenant.shiftPolicy)}
        initialWalkoutDangerMinutes={tenant.walkoutDangerMinutes ?? 20}
      />
    </div>
  );
}
