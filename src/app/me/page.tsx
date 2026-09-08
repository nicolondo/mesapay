import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations, getLocale } from "next-intl/server";
import { signOut } from "@/auth";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { fmtBogotaDateTime } from "@/lib/bogota";
import {
  getViewer,
  listActiveCustomerSessions,
  touchCustomerSession,
} from "@/lib/customerSession";
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

export default async function CustomerHome() {
  // getViewer resuelve primero la sesión revocable del comensal y cae al
  // JWT de NextAuth si no hay: quien ya tenía sesión abierta antes de este
  // cambio no queda en la calle.
  const viewer = await getViewer();
  if (!viewer) redirect("/cuenta/entrar?callbackUrl=/me");

  const t = await getTranslations("me");
  const locale = (await getLocale()) as Locale;
  const userId = viewer.id;

  const [user, orders, sessions] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
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
    db.order.findMany({
      where: { customerId: userId },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        shortCode: true,
        status: true,
        totalCents: true,
        createdAt: true,
        paidAt: true,
        restaurant: { select: { slug: true, name: true } },
        table: { select: { number: true } },
        _count: { select: { items: true } },
      },
    }),
    listActiveCustomerSessions(userId),
  ]);

  if (!user) redirect("/cuenta/entrar?callbackUrl=/me");

  // Best-effort: mantiene "última actividad" con algo útil en la lista de
  // dispositivos. Si falla, la sesión sigue funcionando igual.
  if (viewer.sessionId) void touchCustomerSession(viewer.sessionId);

  return (
    <main className="flex-1 bg-bone">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="flex items-start justify-between mb-8">
          <div>
            <div className="font-mono text-[10px] tracking-[0.18em] uppercase text-muted">
              {t("eyebrow")}
            </div>
            <h1 className="font-display text-3xl tracking-[-0.015em] mt-1">
              {user.name ?? t("greeting")}
            </h1>
            <div className="font-mono text-[11px] text-muted mt-1">
              {user.email}
            </div>
            <div className="font-mono text-[11px] text-muted mt-0.5">
              {t("fieldCedula")}: {user.cedula ?? t("cedulaEmpty")}
            </div>
          </div>
          {/* El logout depende de cómo entró: la sesión del comensal se
              revoca en DB (SecurityPanel); la vieja de NextAuth se cierra
              con signOut. */}
          {viewer.via === "nextauth" ? (
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="h-10 px-4 rounded-full border border-hairline text-sm text-ink bg-paper"
              >
                {t("signOut")}
              </button>
            </form>
          ) : null}
        </div>

        <section className="mb-10">
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mb-3">
            {t("ordersTitle")}
          </div>
          {orders.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-hairline bg-paper p-8 text-center">
              <div className="text-sm text-muted">{t("ordersEmpty")}</div>
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
                          {o.restaurant.name}
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
                        · {o.shortCode} · {t("items", { count: o._count.items })}
                      </div>
                      <div className="font-mono text-[10px] text-muted mt-0.5">
                        {dt.date} · {dt.time}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-display text-xl tabular">
                        {fmtCOP(o.totalCents)}
                      </div>
                      {!paid && o.status !== "cancelled" && (
                        <Link
                          href={`/t/${o.restaurant.slug}/order/${o.id}`}
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
            initial={{
              name: user.name ?? "",
              phone: user.phone ?? "",
              marketingOptIn: user.marketingOptIn,
            }}
          />
        </section>

        <section>
          <div className="font-mono text-[10px] tracking-[0.16em] uppercase text-muted mb-3">
            {t("securityTitle")}
          </div>
          <SecurityPanel
            locale={locale}
            viaNextAuth={viewer.via === "nextauth"}
            currentSessionId={viewer.sessionId}
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
