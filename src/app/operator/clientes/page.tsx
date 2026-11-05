import { auth } from "@/auth";
import { BillingCustomers } from "@/components/billingCustomers/BillingCustomers";
import { CustomersHeader, CustomersTabs } from "@/components/billingCustomers/ListControls";
import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { CUSTOMERS_PATH, parseCustomerListParams } from "@/lib/billingCustomerList";
import { loadBillingCustomerPage } from "@/lib/billingCustomerListQueries";
import { dinerListHref, parseCustomersView, parseDinerListParams } from "@/lib/dinerList";
import { loadDinerPage } from "@/lib/dinerListQueries";
import { BILLING_CUSTOMER_WRITE_ROLES } from "@/lib/billingCustomers";
import { DinersList } from "./DinersList";

export const dynamic = "force-dynamic";

/**
 * Clientes del restaurante, en dos pestañas (cada una es una URL):
 *
 *  · Para facturación (`BillingCustomers`): los contactos que el comercio
 *    crea para facturarles, con su crédito, deuda y descuento. Sólo para
 *    quien puede gestionarlos (operador y administradores).
 *  · Comensales registrados (`DinersList`): las cuentas que los comensales
 *    crearon desde la carta, con lo que han consumido acá.
 *
 * Las dos listas se buscan, filtran, ordenan y paginan EN LA BASE sobre
 * todos los registros del comercio (antes la de facturación se cortaba en
 * 50 y la de comensales en los 500 más recientes). Los filtros viven en la
 * URL: sobreviven a recargar y al botón atrás.
 *
 * ── Comensales: por qué esta pantalla puede listarlos ─────────────────
 * Con el registro por comercio (`Diner.restaurantId`) la base de comensales
 * es de este local; el consumo se calcula sólo con sus órdenes pagadas. El
 * `restaurantId` viene siempre de la sesión (getActiveRestaurantId), nunca
 * de la URL ni del cliente.
 */
export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("opCustomers");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const [session, sp, restaurant] = await Promise.all([
    auth(),
    searchParams,
    db.restaurant.findUnique({ where: { id: restaurantId }, select: { country: true } }),
  ]);
  const canManageCustomers = (BILLING_CUSTOMER_WRITE_ROLES as readonly string[]).includes(session?.user?.role ?? "");
  const currency = await getCurrencyForCountry(restaurant?.country ?? "CO");
  const view = parseCustomersView(sp, canManageCustomers);

  const tabs = (billingCount: number, dinerCount: number) =>
    canManageCustomers ? (
      <CustomersTabs
        // Con clave: el elemento viaja del servidor como prop y el cliente lo
        // pinta junto a otros hijos (sin ella React avisa "unique key").
        key="tabs"
        label={t("tabsLabel")}
        items={[
          { href: CUSTOMERS_PATH, label: t("tabBilling"), count: billingCount, active: view === "billing" },
          { href: dinerListHref({}), label: t("tabDiners"), count: dinerCount, active: view === "diners" },
        ]}
      />
    ) : null;

  return (
    <div className="p-4 lg:p-6 max-w-6xl mx-auto w-full">
      {view === "billing" ? (
        <BillingView restaurantId={restaurantId} sp={sp} currency={currency} tabs={tabs} />
      ) : (
        <DinersView
          restaurantId={restaurantId}
          sp={sp}
          currency={currency}
          tabs={tabs}
          showBillingCount={canManageCustomers}
          header={<CustomersHeader key="header" title={t("title")} subtitle={t(canManageCustomers ? "subtitle" : "subtitleDiners")} />}
        />
      )}
    </div>
  );
}

type Tabs = (billingCount: number, dinerCount: number) => React.ReactNode;

async function BillingView({
  restaurantId,
  sp,
  currency,
  tabs,
}: {
  restaurantId: string;
  sp: Record<string, string | string[] | undefined>;
  currency: string;
  tabs: Tabs;
}) {
  const params = parseCustomerListParams(sp);
  const [list, dinerCount] = await Promise.all([
    loadBillingCustomerPage(restaurantId, params),
    db.diner.count({ where: { restaurantId } }),
  ]);
  return <BillingCustomers list={list} params={{ ...params, page: list.page }} currency={currency} tabs={tabs(list.allCount, dinerCount)} />;
}

async function DinersView({
  restaurantId,
  sp,
  currency,
  tabs,
  header,
  showBillingCount,
}: {
  restaurantId: string;
  sp: Record<string, string | string[] | undefined>;
  currency: string;
  tabs: Tabs;
  header: React.ReactNode;
  showBillingCount: boolean;
}) {
  const params = parseDinerListParams(sp);
  const [list, billingCount] = await Promise.all([
    loadDinerPage(restaurantId, params),
    showBillingCount ? db.billingCustomer.count({ where: { restaurantId } }) : Promise.resolve(0),
  ]);
  return (
    <DinersList
      list={list}
      params={{ ...params, page: list.page }}
      currency={currency}
      header={header}
      tabs={tabs(billingCount, list.allCount)}
    />
  );
}
