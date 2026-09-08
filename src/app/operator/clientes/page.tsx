import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { formatMoney } from "@/lib/format";
import {
  buildCustomerRows,
  customerListWheres,
  CUSTOMER_LIST_LIMIT,
  type CustomerListRow,
} from "@/lib/customerLink";
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
 * está limitado a su propio local: TODA consulta lleva `restaurantId` en el
 * where. Sin eso, el restaurante A vería lo que esa persona gastó en el B —
 * una fuga de datos entre clientes de la plataforma.
 *
 * Por lo mismo, la lista NO es "todos los role = customer": eso le
 * mostraría a cada restaurante la base de comensales de los demás.
 *
 * ── Quién entra a la lista ────────────────────────────────────────────
 * Los que tienen una relación REAL con este restaurante, por tres
 * orígenes registrados (ver lib/customerLink.ts):
 *   1. consumieron acá
 *   2. tienen un descuento pactado acá
 *   3. se registraron desde acá, o el operador los agregó a mano
 *
 * Antes solo contaba el (1), y por eso alguien que creó su cuenta y todavía
 * no ha pedido nada era invisible para el local — el operador no podía
 * habilitarle un descuento sin saberse la cédula de memoria.
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

  // Los tres where salen de una sola función que EXIGE el restaurantId,
  // para que el aislamiento no dependa de que nadie lo olvide acá.
  const wheres = customerListWheres(restaurantId);

  const [grouped, discounts, links] = await Promise.all([
    // Consumo: agrupado SOLO sobre las órdenes pagadas de este restaurante.
    db.order.groupBy({
      by: ["customerId"],
      where: wheres.paidOrders,
      _sum: { totalCents: true },
      _count: { _all: true },
      orderBy: { _sum: { totalCents: "desc" } },
      take: CUSTOMER_LIST_LIMIT,
    }),
    // Descuentos: también por restaurante — el que pactó otro local no se
    // muestra ni se aplica acá. Se traen los apagados también: son vínculo
    // igual, aunque el porcentaje no esté vigente.
    db.customerDiscount.findMany({
      where: wheres.discounts,
      select: { userId: true, percent: true, active: true },
      take: CUSTOMER_LIST_LIMIT,
    }),
    // Vínculos explícitos: registrados desde acá o agregados a mano.
    db.restaurantCustomer.findMany({
      where: wheres.links,
      select: { userId: true, source: true },
      orderBy: { createdAt: "desc" },
      take: CUSTOMER_LIST_LIMIT,
    }),
  ]);

  const spend = grouped
    .filter((g): g is typeof g & { customerId: string } => g.customerId !== null)
    .map((g) => ({
      userId: g.customerId,
      orders: g._count._all,
      totalCents: g._sum.totalCents ?? 0,
    }));

  const ids = [
    ...new Set([
      ...spend.map((s) => s.userId),
      ...discounts.map((d) => d.userId),
      ...links.map((l) => l.userId),
    ]),
  ];

  // La identidad se pide en un solo lote, por id — nunca por `role`, que
  // traería comensales de toda la plataforma.
  const users = ids.length
    ? await db.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true, cedula: true },
      })
    : [];

  const rows = buildCustomerRows({ users, spend, discounts, links });

  // Etiqueta de "por qué está acá" — solo para quien todavía no ha
  // consumido; si ya consumió, el total de la fila lo dice todo. El
  // descuento solo se nombra cuando está apagado: si está vigente, el badge
  // del porcentaje ya lo dijo y repetirlo es ruido.
  function originLabel(row: CustomerListRow): string | null {
    if (row.origins.includes("orders")) return null;
    if (row.origins.includes("signup")) return t("originSignup");
    if (row.origins.includes("added")) return t("originAdded");
    if (row.origins.includes("discount") && row.discountPct === null) {
      return t("originDiscount");
    }
    return null;
  }

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
          {rows.map((r) => {
            const origin = originLabel(r);
            return (
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
                      {origin && (
                        <div className="font-mono text-[10px] tracking-wider uppercase text-muted-2 mt-1">
                          {origin}
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
            );
          })}
        </ul>
      )}
    </div>
  );
}
