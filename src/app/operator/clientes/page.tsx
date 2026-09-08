import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { formatMoney } from "@/lib/format";
import type { Locale } from "@/i18n/config";
import { CustomerLookup } from "./CustomerLookup";

export const dynamic = "force-dynamic";

/**
 * Lista de comensales del restaurante.
 *
 * ── La regla que sostiene esta pantalla ───────────────────────────────
 * La identidad del comensal es GLOBAL: `User.email` es único en toda la
 * plataforma, así que una persona que come en dos restaurantes MESAPAY
 * tiene UNA sola cuenta. Pero lo que cada restaurante VE de esa persona
 * está limitado a su propio local: TODA consulta de consumo lleva
 * `restaurantId` en el where. Sin eso, el restaurante A vería lo que esa
 * persona gastó en el B — una fuga de datos entre clientes de la
 * plataforma.
 *
 * El `restaurantId` viene siempre de la sesión (getActiveRestaurantId),
 * nunca de la URL ni del cliente.
 */
export default async function ClientesPage() {
  const t = await getTranslations("opCustomers");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const locale = (await getLocale()) as Locale;
  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { country: true },
  });
  const currency = await getCurrencyForCountry(restaurant?.country ?? "CO");

  // Agrupamos por cliente SOLO sobre las órdenes de ESTE restaurante.
  const grouped = await db.order.groupBy({
    by: ["customerId"],
    where: {
      restaurantId,
      customerId: { not: null },
      status: "paid",
    },
    _sum: { totalCents: true },
    _count: { _all: true },
    orderBy: { _sum: { totalCents: "desc" } },
    take: 100,
  });

  const ids = grouped
    .map((g) => g.customerId)
    .filter((id): id is string => id !== null);

  const [users, discounts] = await Promise.all([
    ids.length
      ? db.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, email: true, cedula: true },
        })
      : Promise.resolve([]),
    // Los descuentos también se leen por restaurante: el que pactó otro
    // local no se muestra ni se aplica acá.
    db.customerDiscount.findMany({
      where: { restaurantId, active: true },
      select: { userId: true, percent: true },
    }),
  ]);

  const userById = new Map(users.map((u) => [u.id, u]));
  const pctByUser = new Map(discounts.map((d) => [d.userId, d.percent]));

  const rows = grouped
    .map((g) => {
      const u = g.customerId ? userById.get(g.customerId) : undefined;
      if (!u) return null;
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        cedula: u.cedula,
        orders: g._count._all,
        totalCents: g._sum.totalCents ?? 0,
        discountPct: pctByUser.get(u.id) ?? null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="font-display text-3xl tracking-[-0.015em] mb-1">
        {t("title")}
      </h1>
      <p className="text-sm text-muted mb-6">{t("subtitle")}</p>

      <CustomerLookup />

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
                    <div className="font-display text-xl tabular">
                      {formatMoney(r.totalCents, { currency, locale })}
                    </div>
                    <div className="font-mono text-[10px] text-muted">
                      {t("ordersCount", { count: r.orders })}
                    </div>
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
