import Link from "next/link";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { IdentidadClient } from "./IdentidadClient";

export const dynamic = "force-dynamic";

export default async function IdentidadPage() {
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">Sin restaurante.</div>;

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      logoUrl: true,
      legalName: true,
      taxId: true,
      legalAddress: true,
      legalPhone: true,
      dianResolution: true,
      dianResolutionFrom: true,
      dianResolutionTo: true,
      dianResolutionDate: true,
      invoicePrefix: true,
      invoiceNextNumber: true,
    },
  });
  if (!tenant) return <div className="p-6">Restaurante no encontrado.</div>;

  return (
    <div className="p-6 max-w-2xl mx-auto w-full">
      <Link
        href="/operator/settings"
        className="text-sm text-op-muted hover:underline"
      >
        ← Configuración
      </Link>
      <div className="font-display text-3xl mt-2 mb-1">Identidad del comercio</div>
      <p className="text-sm text-op-muted mb-6">
        Logo, razón social, NIT y resolución DIAN. Esta información
        aparece en las facturas que envías al cliente y en el menú que
        ve al escanear el QR.
      </p>

      <IdentidadClient
        initial={{
          logoUrl: tenant.logoUrl,
          legalName: tenant.legalName,
          taxId: tenant.taxId,
          legalAddress: tenant.legalAddress,
          legalPhone: tenant.legalPhone,
          dianResolution: tenant.dianResolution,
          dianResolutionFrom: tenant.dianResolutionFrom,
          dianResolutionTo: tenant.dianResolutionTo,
          dianResolutionDate: tenant.dianResolutionDate
            ? tenant.dianResolutionDate.toISOString().slice(0, 10)
            : null,
          invoicePrefix: tenant.invoicePrefix,
          invoiceNextNumber: tenant.invoiceNextNumber,
        }}
      />
    </div>
  );
}
