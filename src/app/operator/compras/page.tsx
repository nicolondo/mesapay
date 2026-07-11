import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { ComprasClient } from "./ComprasClient";

export const dynamic = "force-dynamic";

/**
 * Compras del comercio — ERP Fase A2: órdenes de compra a proveedores
 * (lista con filtro por estado, creación con líneas desde la lista de
 * precios y detalle con acciones). Superficie propia en la nav (operación
 * diaria, no configuración). Gate estricto: SOLO con el módulo
 * `purchasing` activado — mismo gate que la API de purchase-orders;
 * apagado, la página no existe (notFound) y el item de nav tampoco.
 */
export default async function ComprasPage() {
  const t = await getTranslations("opErp");
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) {
    return <div className="p-6">{tSettings("noRestaurant")}</div>;
  }

  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { enabledModules: true, country: true },
  });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "purchasing")) {
    notFound();
  }

  // Primera página de órdenes (todos los estados) con la MISMA forma que
  // GET /api/operator/purchase-orders — el client filtra y pagina contra
  // esa API con el mismo cursor.
  const orders = await db.purchaseOrder.findMany({
    where: { restaurantId },
    take: 20,
    orderBy: [{ createdAt: "desc" }],
    include: {
      supplier: { select: { id: true, name: true } },
      items: {
        select: {
          expectedCostCents: true,
          receivedCostCents: true,
          taxPct: true,
        },
      },
      _count: { select: { items: true } },
    },
  });
  const nextCursor =
    orders.length === 20 ? orders[orders.length - 1].id : null;

  // Proveedores activos para el combobox de "Nueva orden".
  const suppliers = await db.supplier.findMany({
    where: { restaurantId, active: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  // Moneda = país del comercio; el locale solo define idioma/formato
  // (regla idioma ≠ moneda de @/lib/format).
  const currency = await getCurrencyForCountry(tenant.country);

  return (
    <div className="p-6 max-w-3xl mx-auto w-full">
      <div className="font-display text-3xl mb-1">{t("comprasTitle")}</div>
      <p className="text-sm text-op-muted mb-6">{t("comprasIntro")}</p>

      <ComprasClient
        initialOrders={orders}
        initialCursor={nextCursor}
        suppliers={suppliers}
        currency={currency}
      />
    </div>
  );
}
