import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations, getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { getActiveRestaurantId } from "@/lib/activeRestaurant";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { formatMoney, formatDate } from "@/lib/format";
import { resolveRange, customerOrdersWhere } from "@/lib/monthRange";
import { getCustomerOrigins } from "@/lib/customerLink";
import type { Locale } from "@/i18n/config";
import { DiscountCard } from "./DiscountCard";
import { RangePicker } from "./RangePicker";
import { RemoveFromListButton } from "./RemoveFromListButton";

export const dynamic = "force-dynamic";

/**
 * Ficha del comensal para el restaurante: su descuento y TODO lo que
 * consumió — pero solo acá.
 *
 * ── El filtro que no se puede omitir ──────────────────────────────────
 * `email` es único en toda la plataforma, así que esta persona puede tener
 * facturas de varios restaurantes MESAPAY. La consulta lleva
 * `restaurantId` en el where SIEMPRE, y ese id sale de la sesión
 * (getActiveRestaurantId), nunca de la URL. Sin ese filtro, el
 * restaurante A vería las facturas del B: una fuga de datos entre clientes
 * de la plataforma.
 *
 * Por la misma razón el total del encabezado se calcula sobre las mismas
 * órdenes filtradas y no con un agregado global del usuario.
 */
export default async function ClienteDetallePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const t = await getTranslations("opCustomers");
  const restaurantId = await getActiveRestaurantId();
  if (!restaurantId) return <div className="p-6">{t("noRestaurant")}</div>;

  const { id: customerId } = await params;
  const sp = await searchParams;
  // Sin parámetros en la URL: el mes en curso.
  const range = resolveRange(sp.from, sp.to);

  const locale = (await getLocale()) as Locale;

  const [customer, restaurant] = await Promise.all([
    db.user.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, email: true, cedula: true, role: true },
    }),
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { country: true },
    }),
  ]);
  if (!customer || customer.role !== "customer") notFound();

  const currency = await getCurrencyForCountry(restaurant?.country ?? "CO");

  const [orders, discount, origins] = await Promise.all([
    db.order.findMany({
      // El where lo arma `customerOrdersWhere`, que EXIGE el restaurantId
      // como parámetro — así el aislamiento entre restaurantes no depende
      // de que nadie lo olvide acá. Hay un test que lo verifica.
      where: customerOrdersWhere({
        restaurantId,
        customerId,
        from: range.from,
        to: range.to,
      }),
      orderBy: { paidAt: "desc" },
      take: 500,
      select: {
        id: true,
        shortCode: true,
        paidAt: true,
        subtotalCents: true,
        discountCents: true,
        discountPct: true,
        tipCents: true,
        totalCents: true,
        table: { select: { number: true } },
        simpleInvoice: { select: { id: true, invoiceNumber: true } },
      },
    }),
    // El descuento también es por restaurante: la llave es el par.
    db.customerDiscount.findUnique({
      where: { restaurantId_userId: { restaurantId, userId: customerId } },
      select: { percent: true, active: true, note: true },
    }),
    // Por qué esta persona está (o no) en la lista de clientes de ESTE
    // restaurante. También se resuelve con el restaurantId de la sesión.
    getCustomerOrigins(restaurantId, customerId),
  ]);

  const totalCents = orders.reduce((s, o) => s + o.totalCents, 0);
  const savedCents = orders.reduce((s, o) => s + o.discountCents, 0);

  // Un texto, el más informativo de los orígenes que tenga.
  const linkNote = origins.includes("orders")
    ? t("linkWhyOrders")
    : origins.includes("discount")
      ? t("linkWhyDiscount")
      : origins.includes("signup")
        ? t("linkWhySignup")
        : origins.includes("added")
          ? t("linkWhyAdded")
          : t("linkWhyNone");

  // Quitar solo tiene efecto real cuando el vínculo explícito es el único
  // motivo: con facturas o descuento de por medio la persona sigue en la
  // lista pase lo que pase.
  const canRemove =
    (origins.includes("signup") || origins.includes("added")) &&
    !origins.includes("orders") &&
    !origins.includes("discount");

  return (
    <div className="p-6 max-w-4xl">
      <Link
        href="/operator/clientes"
        className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
      >
        {t("backToList")}
      </Link>

      <h1 className="font-display text-3xl tracking-[-0.015em] mt-2 mb-1">
        {customer.name ?? customer.email}
      </h1>
      <div className="font-mono text-[11px] text-muted mb-1">
        {customer.email}
      </div>
      <div className="font-mono text-[11px] text-muted mb-6">
        {t("cedula")}: {customer.cedula ?? t("cedulaEmpty")}
      </div>

      <div className="rounded-2xl border border-hairline bg-paper p-5 mb-4">
        <div className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted mb-1">
          {t("linkTitle")}
        </div>
        <p className="text-sm text-muted">{linkNote}</p>
        {canRemove && <RemoveFromListButton customerId={customer.id} />}
      </div>

      <DiscountCard
        customerId={customer.id}
        initial={
          discount?.active
            ? { percent: discount.percent, note: discount.note }
            : null
        }
      />

      <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mt-8 mb-3">
        {t("invoicesTitle")}
      </div>
      <p className="text-xs text-muted-2 mb-3">{t("scopeNote")}</p>

      <RangePicker from={range.from} to={range.to} />

      <div className="flex flex-wrap gap-4 my-4">
        <div className="rounded-xl border border-hairline bg-paper px-4 py-3">
          <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
            {t("statOrders")}
          </div>
          <div className="font-display text-2xl tabular">{orders.length}</div>
        </div>
        <div className="rounded-xl border border-hairline bg-paper px-4 py-3">
          <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
            {t("statTotal")}
          </div>
          <div className="font-display text-2xl tabular">
            {formatMoney(totalCents, { currency, locale })}
          </div>
        </div>
        {savedCents > 0 && (
          <div className="rounded-xl border border-hairline bg-paper px-4 py-3">
            <div className="font-mono text-[10px] tracking-wider uppercase text-muted">
              {t("statSaved")}
            </div>
            <div className="font-display text-2xl tabular text-terracotta">
              {formatMoney(savedCents, { currency, locale })}
            </div>
          </div>
        )}
      </div>

      {orders.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-hairline bg-paper p-8 text-center text-sm text-muted">
          {t("noInvoices")}
        </div>
      ) : (
        <ul className="space-y-2">
          {orders.map((o) => (
            <li
              key={o.id}
              className="rounded-xl border border-hairline bg-paper p-4 flex items-start justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="font-mono text-sm">
                  {o.simpleInvoice ? `#${o.simpleInvoice.invoiceNumber}` : o.shortCode}
                </div>
                <div className="font-mono text-[11px] text-muted mt-0.5">
                  {o.table.number > 0
                    ? t("table", { number: o.table.number })
                    : t("counter")}
                  {o.paidAt
                    ? ` · ${formatDate(o.paidAt, { locale })}`
                    : ""}
                </div>
                {o.discountCents > 0 && (
                  <div className="font-mono text-[10px] text-terracotta mt-0.5">
                    {o.discountPct
                      ? t("discountApplied", { pct: o.discountPct })
                      : t("discountAppliedNoPct")}{" "}
                    {"− " + formatMoney(o.discountCents, { currency, locale })}
                  </div>
                )}
              </div>
              <div className="text-right shrink-0">
                <div className="font-display text-xl tabular">
                  {formatMoney(o.totalCents, { currency, locale })}
                </div>
                {o.simpleInvoice && (
                  <Link
                    href={`/factura/${o.simpleInvoice.id}`}
                    className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
                  >
                    {t("openInvoice")}
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
