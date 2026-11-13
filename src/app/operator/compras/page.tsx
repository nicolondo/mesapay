import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { ComprasClient } from "./ComprasClient";
import { parsePurchaseListParams } from "@/lib/erp/purchaseList";
import { loadPurchaseFilterSuppliers, loadPurchaseListPage } from "@/lib/erp/purchaseListQueries";
import { loadSupplierCreditBalances } from "@/lib/erp/reports/supplierCreditCartera";
import { todayIso } from "@/lib/erp/reports/period";
import { SupplierCreditBanner } from "./SupplierCreditBanner";

export const dynamic = "force-dynamic";

/**
 * Compras del comercio — ERP Fase A2: órdenes de compra a proveedores
 * (lista, creación con líneas desde la lista de precios y detalle con
 * acciones). Superficie propia en la nav (operación diaria, no
 * configuración). Gate estricto: SOLO con el módulo `purchasing` activado
 * — mismo gate que la API de purchase-orders; apagado, la página no existe
 * (notFound) y el item de nav tampoco.
 *
 * La lista (pestañas «Órdenes» y «Por pagar») se busca, filtra —proveedor,
 * estado, fechas— y pagina EN EL SERVIDOR sobre todas las compras del
 * comercio, y el resumen (total a pagar, vencido, total de las compras) es
 * de todo lo que cumple los filtros. Los filtros viven en la URL.
 */
export default async function ComprasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
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

  const sp = await searchParams;
  // Proveedores del comercio (también inactivos: tienen compras viejas) para
  // el filtro; los activos van al autocompletado de "Nueva orden" y de la
  // revisión de facturas. Un proveedor de la URL que no es de este comercio
  // se ignora.
  const allSuppliers = await loadPurchaseFilterSuppliers(restaurantId);
  const suppliers = allSuppliers
    .filter((s) => s.active)
    .map(({ id, name, taxId }) => ({ id, name, taxId }));
  const parsed = parsePurchaseListParams(sp);
  const params = allSuppliers.some((s) => s.id === parsed.supplier) ? parsed : { ...parsed, supplier: "" };
  const list = await loadPurchaseListPage(restaurantId, params);
  // «Por pagar»: el saldo a favor de los proveedores (notas crédito sin
  // cruzar) se muestra aparte, no como deuda negativa.
  const credits =
    params.tab === "unpaid" ? await loadSupplierCreditBalances(restaurantId, todayIso(), params.supplier || undefined) : [];

  // `?oc=<id>` (enlace desde Reportes, Cartera o el aviso de factura
  // repetida): abre el detalle de esa orden si es de este comercio; si no,
  // se ignora.
  const ocParam = sp.oc;
  const oc = Array.isArray(ocParam) ? ocParam[0] : ocParam;
  const initialDetailId =
    oc && /^[a-z0-9]{10,40}$/i.test(oc)
      ? ((await db.purchaseOrder.findFirst({ where: { id: oc, restaurantId }, select: { id: true } }))?.id ?? null)
      : null;

  // Moneda = país del comercio; el locale solo define idioma/formato
  // (regla idioma ≠ moneda de @/lib/format).
  const currency = await getCurrencyForCountry(tenant.country);

  return (
    <div className="p-4 lg:p-6 max-w-6xl mx-auto w-full">
      <h1 className="font-display text-2xl lg:text-3xl tracking-[-0.015em]">{t("comprasTitle")}</h1>
      {/* En el celular la bajada se omite: la lista sube. */}
      <p className="hidden sm:block text-sm text-op-muted mt-1 mb-5 max-w-2xl">{t("comprasIntro")}</p>
      <div className="h-4 sm:hidden" />

      {credits.length > 0 && (
        <SupplierCreditBanner
          totalCents={credits.reduce((s, c) => s + c.availableCents, 0)}
          suppliers={credits.length}
          supplierId={params.supplier || null}
          currency={currency}
        />
      )}

      <ComprasClient
        list={list}
        params={{ ...params, page: list.page }}
        suppliers={suppliers}
        filterSuppliers={allSuppliers.map(({ id, name, taxId }) => ({ id, name, taxId }))}
        currency={currency}
        initialDetailId={initialDetailId}
      />
    </div>
  );
}
