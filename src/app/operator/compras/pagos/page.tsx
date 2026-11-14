import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { loadSupplierPaymentList } from "@/lib/erp/supplierPaymentQueries";
import { ComprasTabs } from "../ComprasTabs";
import { PaymentsClient } from "./PaymentsClient";

export const dynamic = "force-dynamic";

/**
 * Compras › Pagos: los comprobantes de egreso (CE-0001…) y «Pagar a
 * proveedor». `?pagar=<proveedor>` abre la hoja con ese proveedor (enlace
 * desde la Cartera); `?proveedor=` filtra la lista.
 */
export default async function PagosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("opErp");
  const tp = await getTranslations("opSupplierPayment");
  const tSettings = await getTranslations("opSettings");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{tSettings("noRestaurant")}</div>;
  const tenant = await db.restaurant.findUnique({ where: { id: restaurantId }, select: { enabledModules: true, country: true } });
  if (!tenant || !isModuleEnabled(tenant.enabledModules, "purchasing")) notFound();

  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const valid = (v: string) => (/^[a-z0-9]{10,40}$/i.test(v) ? v : null);
  const supplierFilter = valid(first(sp.proveedor));
  const page = Number(first(sp.pagina) || "1");
  const [list, suppliers, currency] = await Promise.all([
    loadSupplierPaymentList(restaurantId, { supplierId: supplierFilter, page: Number.isFinite(page) ? page : 1 }),
    db.supplier.findMany({ where: { restaurantId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, taxId: true } }),
    getCurrencyForCountry(tenant.country),
  ]);
  const payFor = valid(first(sp.pagar));
  return (
    <div className="p-4 lg:p-6 max-w-6xl mx-auto w-full">
      <h1 className="font-display text-2xl lg:text-3xl tracking-[-0.015em]">{t("comprasTitle")}</h1>
      <p className="hidden sm:block text-sm text-op-muted mt-1 mb-5 max-w-2xl">{tp("pageIntro")}</p>
      <div className="h-4 sm:hidden" />
      <ComprasTabs active="payments" />
      <PaymentsClient
        list={list}
        suppliers={suppliers}
        currency={currency}
        initialPayFor={payFor && suppliers.some((s) => s.id === payFor) ? payFor : null}
        supplierFilter={supplierFilter}
      />
    </div>
  );
}
