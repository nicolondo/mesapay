import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations, getLocale } from "next-intl/server";
import { db } from "@/lib/db";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { formatMoney } from "@/lib/format";
import { fmtBogotaDateTime } from "@/lib/bogota";
import {
  getDiner,
  listActiveDinerSessions,
  touchDinerSession,
} from "@/lib/dinerSession";
import type { Locale } from "@/i18n/config";
import { ProfileForm } from "./ProfileForm";
import { SecurityPanel } from "./SecurityPanel";

export const dynamic = "force-dynamic";

/** OrderStatus → clave del catálogo. */
const STATUS_KEY: Record<string, string> = {
  open: "statusOpen",
  placed: "statusPlaced",
  in_kitchen: "statusInKitchen",
  ready: "statusReady",
  served: "statusServed",
  paying: "statusPaying",
  paid: "statusPaid",
  cancelled: "statusCancelled",
};

/**
 * "Mi cuenta" del comensal EN ESTE COMERCIO.
 *
 * Antes esta pantalla vivía en /me y mostraba las órdenes de la persona en
 * TODOS los restaurantes MESAPAY, porque la identidad era global. Ahora la
 * cuenta es del comercio: lo que se ve acá es lo de este local, y su cuenta
 * del restaurante de al lado es otra, con su propia pantalla.
 */
export default async function TenantDinerAccountPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tenant = await db.restaurant.findUnique({
    where: { slug },
    select: { id: true, name: true, country: true },
  });
  if (!tenant) return notFound();

  const diner = await getDiner(tenant.id);
  if (!diner) {
    redirect(`/t/${slug}/cuenta/entrar?callbackUrl=/t/${slug}/cuenta`);
  }

  const t = await getTranslations("me");
  const locale = (await getLocale()) as Locale;
  const currency = await getCurrencyForCountry(tenant.country ?? "CO");

  const [profile, orders, sessions] = await Promise.all([
    db.diner.findUnique({
      where: { id: diner.id },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        cedula: true,
        marketingOptIn: true,
        createdAt: true,
      },
    }),
    // Solo las órdenes de ESTE restaurante. El `restaurantId` sobra por
    // construcción (un comensal es de un solo local) pero se deja explícito:
    // la consulta dice lo que la pantalla promete.
    db.order.findMany({
      where: { dinerId: diner.id, restaurantId: tenant.id },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        shortCode: true,
        status: true,
        totalCents: true,
        createdAt: true,
        table: { select: { number: true } },
        _count: { select: { items: true } },
      },
    }),
    listActiveDinerSessions(diner.id),
  ]);

  if (!profile) {
    redirect(`/t/${slug}/cuenta/entrar?callbackUrl=/t/${slug}/cuenta`);
  }

  // Best-effort: mantiene "última actividad" con algo útil en la lista de
  // dispositivos. Si falla, la sesión sigue funcionando igual.
  void touchDinerSession(diner.sessionId);

  return (
    <main className="flex-1 bg-bone">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="mb-8">
          <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted">
            {t("eyebrowTenant", { restaurant: tenant.name })}
          </div>
          <h1 className="font-display text-3xl tracking-[-0.015em] mt-1">
            {profile.name ?? t("greeting")}
          </h1>
          <div className="font-mono text-[11px] text-muted mt-1">
            {profile.email}
          </div>
          <div className="font-mono text-[11px] text-muted mt-0.5">
            {t("fieldCedula")}: {profile.cedula ?? t("cedulaEmpty")}
          </div>
          <p className="text-xs text-muted-2 mt-3 leading-snug max-w-md">
            {t("scopeNote", { restaurant: tenant.name })}
          </p>
        </div>

        <section className="mb-10">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mb-3">
            {t("ordersTitle")}
          </div>
          {orders.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-hairline bg-paper p-8 text-center">
              <div className="text-sm text-muted">
                {t("ordersEmptyTenant", { restaurant: tenant.name })}
              </div>
            </div>
          ) : (
            <ul className="space-y-2">
              {orders.map((o) => {
                const dt = fmtBogotaDateTime(o.createdAt);
                const paid = o.status === "paid";
                return (
                  <li
                    key={o.id}
                    className="rounded-xl border border-hairline bg-paper p-4 flex items-start justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-display text-lg tracking-[-0.01em]">
                          {o.shortCode}
                        </span>
                        <span
                          className={
                            "font-mono text-[9px] tracking-wider uppercase px-2 py-0.5 rounded border " +
                            (paid
                              ? "bg-ok/10 text-[#1E5339] border-ok/30"
                              : o.status === "cancelled"
                                ? "bg-danger/10 text-danger border-danger/25"
                                : "bg-paper text-muted border-hairline")
                          }
                        >
                          {STATUS_KEY[o.status] ? t(STATUS_KEY[o.status]) : o.status}
                        </span>
                      </div>
                      <div className="font-mono text-[11px] text-muted mt-1 truncate">
                        {o.table.number > 0
                          ? t("table", { number: o.table.number })
                          : t("counter")}{" "}
                        · {t("items", { count: o._count.items })}
                      </div>
                      <div className="font-mono text-[10px] text-muted mt-0.5">
                        {dt.date} · {dt.time}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-display text-xl tabular">
                        {formatMoney(o.totalCents, { currency, locale })}
                      </div>
                      {!paid && o.status !== "cancelled" && (
                        <Link
                          href={`/t/${slug}/order/${o.id}`}
                          className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
                        >
                          {t("openOrder")}
                        </Link>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="mb-10">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mb-3">
            {t("profileTitle")}
          </div>
          <ProfileForm
            slug={slug}
            initial={{
              name: profile.name ?? "",
              phone: profile.phone ?? "",
              marketingOptIn: profile.marketingOptIn,
            }}
          />
        </section>

        <section>
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mb-3">
            {t("securityTitle")}
          </div>
          <SecurityPanel
            slug={slug}
            locale={locale}
            currentSessionId={diner.sessionId}
            sessions={sessions.map((s) => ({
              id: s.id,
              userAgent: s.userAgent,
              createdAt: s.createdAt.toISOString(),
              lastUsedAt: s.lastUsedAt.toISOString(),
            }))}
          />
        </section>
      </div>
    </main>
  );
}
