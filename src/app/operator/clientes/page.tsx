import Link from "next/link";
import { auth } from "@/auth";
import { BillingCustomers } from "@/components/billingCustomers/BillingCustomers";
import { getTranslations, getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { formatMoney, formatDate } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { DinerLookup } from "./DinerLookup";

export const dynamic = "force-dynamic";

/**
 * Lista de comensales del restaurante.
 *
 * ── Por qué esta pantalla ahora puede listar de verdad ────────────────
 * Antes la identidad del comensal era global (`User.email` único en toda la
 * plataforma), así que "los comensales" no era un conjunto que le
 * perteneciera a nadie: listar registrados le habría mostrado a cada
 * restaurante la base de los demás. Por eso la lista solo podía armarse
 * desde las ÓRDENES pagadas acá, y quien se había registrado sin consumir
 * todavía era invisible.
 *
 * Con el registro por comercio (`Diner.restaurantId`), la base de
 * comensales SÍ es de este local: acá se listan todos los suyos, hayan
 * pedido o no. El consumo se sigue calculando solo sobre las órdenes de
 * este restaurante, que por construcción son las únicas que puede tener.
 *
 * El `restaurantId` viene siempre de la sesión (getActiveRestaurantId),
 * nunca de la URL ni del cliente.
 */
export default async function ClientesPage() {
  const t = await getTranslations("opCustomers");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const session = await auth();
  const canManageCustomers = ["operator", "platform_admin", "group_admin"].includes(session?.user?.role ?? "");
  const locale = (await getLocale()) as Locale;
  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { country: true },
  });
  const currency = await getCurrencyForCountry(restaurant?.country ?? "CO");

  const diners = await db.diner.findMany({
    where: { restaurantId },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: {
      id: true,
      name: true,
      email: true,
      cedula: true,
      createdAt: true,
      discount: { select: { percent: true, active: true } },
    },
  });

  // Consumo por comensal, solo con las órdenes pagadas de ESTE restaurante.
  const spend = diners.length
    ? await db.order.groupBy({
        by: ["dinerId"],
        where: {
          restaurantId,
          dinerId: { in: diners.map((d) => d.id) },
          status: "paid",
        },
        _sum: { totalCents: true },
        _count: { _all: true },
      })
    : [];
  const spendByDiner = new Map(
    spend.map((g) => [
      g.dinerId,
      { orders: g._count._all, totalCents: g._sum.totalCents ?? 0 },
    ]),
  );

  // Los que más han consumido arriba; los que todavía no consumieron,
  // ordenados por registro más reciente (que es como llegaron de la lista).
  const rows = diners
    .map((d) => ({
      id: d.id,
      name: d.name,
      email: d.email,
      cedula: d.cedula,
      createdAt: d.createdAt,
      orders: spendByDiner.get(d.id)?.orders ?? 0,
      totalCents: spendByDiner.get(d.id)?.totalCents ?? 0,
      discountPct: d.discount?.active ? d.discount.percent : null,
    }))
    .sort((a, b) => b.totalCents - a.totalCents);

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="font-display text-3xl tracking-[-0.015em] mb-1">
        {t("title")}
      </h1>
      <p className="text-sm text-muted mb-6">{t("subtitle")}</p>

      {canManageCustomers && <BillingCustomers />}

      <DinerLookup />

      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mt-8 mb-3">
        {t("listTitle")}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-hairline bg-paper p-8 text-center text-sm text-muted">
          {t("empty")}
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Link
                href={`/operator/clientes/${r.id}`}
                className="block rounded-xl border border-hairline bg-paper p-4 hover:border-terracotta"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="font-display text-lg tracking-[-0.01em] truncate">
                      {r.name ?? r.email}
                    </div>
                    <div className="font-mono text-[11px] text-muted truncate">
                      {r.cedula ?? r.email}
                    </div>
                    {r.discountPct !== null && (
                      <div className="font-mono text-[10px] tracking-wider uppercase text-terracotta mt-1">
                        {t("discountBadge", { pct: r.discountPct })}
                      </div>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    {r.orders === 0 ? (
                      <>
                        <div className="font-mono text-[11px] text-muted">
                          {t("noOrdersYet")}
                        </div>
                        <div className="font-mono text-[10px] text-muted-2">
                          {t("registeredOn", {
                            date: formatDate(r.createdAt, { locale }),
                          })}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="font-display text-xl tabular">
                          {formatMoney(r.totalCents, { currency, locale })}
                        </div>
                        <div className="font-mono text-[10px] text-muted">
                          {t("ordersCount", { count: r.orders })}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
