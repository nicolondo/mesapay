import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { type Locale } from "@/i18n/config";
import { IMPERSONATE_COOKIE, getActiveContext } from "@/lib/activeRestaurant";
import { deriveMembershipStatus } from "@/lib/membership";
import { OperatorMobileMenu } from "./OperatorMobileMenu";
import { GroupSwitcher } from "./GroupSwitcher";
import { LocaleSwitcher } from "@/components/LocaleSwitcher";

export default async function OperatorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin?callbackUrl=/operator");
  const t = await getTranslations("operator");
  // group_admin entra acá cuando está impersonando un restaurante
  // de su grupo (validación de scope ya en getActiveContext).
  if (
    session.user.role !== "operator" &&
    session.user.role !== "platform_admin" &&
    session.user.role !== "group_admin"
  ) {
    redirect("/");
  }

  const ctx = await getActiveContext();
  const restaurantId = ctx?.restaurantId ?? null;
  const impersonating = ctx?.impersonating ?? false;
  const isGroupAdmin = session.user.role === "group_admin";
  const isPlatformAdmin = session.user.role === "platform_admin";

  // Platform admin without impersonation → /admin/restaurants para
  // elegir. Group admin sin impersonar → /group para elegir.
  if (isPlatformAdmin && !restaurantId) {
    redirect("/admin/restaurants");
  }
  if (isGroupAdmin && !restaurantId) {
    redirect("/group");
  }

  // Para el switcher del header — restaurantes hermanos del mismo
  // grupo. Sólo se carga cuando el usuario está impersonando desde
  // contexto de grupo (group_admin o platform_admin sobre un local
  // grupado).
  let siblingRestaurants: { id: string; name: string }[] = [];
  let groupId: string | null = null;
  if (impersonating && restaurantId) {
    const r = await db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { groupId: true },
    });
    groupId = r?.groupId ?? null;
    if (groupId) {
      siblingRestaurants = await db.restaurant.findMany({
        where: { groupId, id: { not: restaurantId } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      });
    }
  }

  const tenant = restaurantId
    ? await db.restaurant.findUnique({ where: { id: restaurantId } })
    : null;

  const membership = tenant
    ? deriveMembershipStatus({
        plan: tenant.plan,
        periodEndsAt: tenant.periodEndsAt,
        suspended: tenant.suspended,
      })
    : null;

  // Real operators hit the lock page when suspended.
  // Platform admins impersonating keep access so they can unblock the account.
  if (
    tenant?.suspended &&
    session.user.role === "operator" &&
    !impersonating
  ) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-op-bg p-6 text-op-text">
        <div className="max-w-md text-center space-y-4">
          <div className="font-display text-3xl">{t("suspendedTitle")}</div>
          <p className="text-sm text-op-muted">
            {t.rich("suspendedBody", {
              name: tenant.name,
              b: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button className="h-10 px-4 rounded-xl bg-ink text-bone text-sm font-medium">
              {t("signOutFull")}
            </button>
          </form>
        </div>
      </div>
    );
  }

  async function stopImpersonating() {
    "use server";
    const jar = await cookies();
    jar.delete(IMPERSONATE_COOKIE);
    // platform_admin vuelve al admin shell; group_admin vuelve a
    // su landing de grupo.
    const s = await auth();
    redirect(s?.user?.role === "group_admin" ? "/group" : "/admin/restaurants");
  }

  // Server action que el switcher del header usa para saltar a otro
  // restaurante del mismo grupo. Re-setea la cookie y refresca.
  async function switchToSibling(formData: FormData) {
    "use server";
    const targetId = String(formData.get("restaurantId") ?? "");
    if (!targetId) return;
    const s = await auth();
    if (!s?.user) return;
    // Sólo group_admin y platform_admin pueden cambiar de
    // restaurante via switcher.
    if (
      s.user.role !== "group_admin" &&
      s.user.role !== "platform_admin"
    ) {
      return;
    }
    // Si es group_admin, validar que el target sea de su grupo.
    if (s.user.role === "group_admin") {
      const target = await db.restaurant.findUnique({
        where: { id: targetId },
        select: { groupId: true },
      });
      if (!target || target.groupId !== s.user.groupId) return;
    }
    const jar = await cookies();
    jar.set(IMPERSONATE_COOKIE, targetId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 8,
    });
    redirect("/operator");
  }

  return (
    <div className="flex flex-1 flex-col bg-op-bg text-op-text min-h-screen">
      {impersonating && (
        <div className="print:hidden bg-terracotta text-bone px-4 md:px-6 py-2 flex items-center justify-between gap-3 text-sm flex-wrap">
          <div className="min-w-0 flex items-center gap-3 flex-wrap">
            <span className="font-mono text-[10px] tracking-wider uppercase opacity-80">
              {isGroupAdmin ? t("impGroup") : t("impImpersonating")}
            </span>
            <span className="truncate">
              {isGroupAdmin ? t("impViewing") : t("impViewingAsOperator")}{" "}
              <strong>{tenant?.name ?? "…"}</strong>
            </span>
            {/* Switcher entre restaurantes del grupo — sólo cuando hay
                hermanos. Auto-submitea con onChange (client component). */}
            <GroupSwitcher
              siblings={siblingRestaurants}
              action={switchToSibling}
            />
          </div>
          <form action={stopImpersonating} className="shrink-0">
            <button className="font-mono text-[10px] tracking-wider uppercase underline">
              {isGroupAdmin ? t("impBackToGroup") : t("impStop")}
            </button>
          </form>
        </div>
      )}
      {membership === "vencido" && (
        <div className="print:hidden bg-danger/15 border-b border-danger/30 text-danger px-4 md:px-6 py-2 text-sm">
          {t.rich("membershipOverdue", {
            b: (chunks) => <strong>{chunks}</strong>,
          })}
        </div>
      )}
      {membership === "por_vencer" && (
        <div className="print:hidden bg-[#C98A2E]/15 border-b border-[#C98A2E]/40 text-[#7F5A1F] px-4 md:px-6 py-2 text-sm">
          {tenant?.periodEndsAt
            ? t("membershipDueSoonDate", {
                date: formatDate(tenant.periodEndsAt, {
                  locale: (await getLocale()) as Locale,
                  year: "numeric",
                  month: "numeric",
                  day: "numeric",
                }),
              })
            : t("membershipDueSoon")}
        </div>
      )}
      {(() => {
        // Single source of truth for the nav so desktop inline + mobile
        // drawer render the same items in the same order. Includes
        // Cocina + Bar conditionally based on tenant config.
        const navItems: { href: string; label: string }[] = [
          { href: "/operator", label: t("navSummary") },
          { href: "/operator/kitchen", label: t("navKitchen") },
          ...(tenant?.hasBar
            ? [{ href: "/operator/bar", label: t("navBar") }]
            : []),
          { href: "/operator/serve", label: t("navHall") },
          ...(tenant?.reservationsEnabled
            ? [{ href: "/operator/reservas", label: t("navReservations") }]
            : []),
          { href: "/operator/payments", label: t("navPayments") },
          { href: "/operator/orders", label: t("navOrders") },
          { href: "/operator/menu", label: t("navMenu") },
          { href: "/operator/menus", label: t("navMenus") },
          {
            href: "/operator/tables",
            label:
              tenant?.serviceMode === "counter"
                ? t("navCounter")
                : t("navTables"),
          },
          { href: "/operator/ratings", label: t("navRatings") },
          { href: "/operator/facturas", label: t("navInvoices") },
          { href: "/operator/reports", label: t("navClose") },
          { href: "/operator/wallet", label: t("navWallet") },
          { href: "/operator/settings", label: t("navSettings") },
          { href: "/operator/insights", label: t("navInsights") },
        ];
        // The signOut server-action gets rendered twice (desktop link +
        // mobile drawer button) so we declare it once and reuse the
        // JSX. Server actions can't be passed across the client/server
        // boundary as functions, but as <form> children they survive.
        const signOutDesktop = (
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button className="text-terracotta hover:underline">
              {t("signOut")}
            </button>
          </form>
        );
        const signOutMobile = (
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <button
              type="submit"
              className="w-full h-11 rounded-full bg-ink text-bone text-sm font-medium"
            >
              {t("signOutFull")}
            </button>
          </form>
        );
        return (
          <header className="print:hidden border-b border-op-border bg-op-surface sticky top-0 z-10">
            <div className="flex items-center justify-between px-4 md:px-6 py-3 gap-3">
              <div className="flex items-center gap-4 md:gap-6 min-w-0">
                <div className="shrink-0 min-w-0">
                  <div className="font-mono text-[9px] tracking-[0.18em] uppercase text-op-muted truncate">
                    {t("roleLabel", { name: tenant?.name ?? t("noRestaurant") })}
                  </div>
                  <div className="font-display text-xl tracking-[-0.015em]">
                    {"MESAPAY"}
                  </div>
                </div>
                {/* Inline nav — desktop only. On mobile the hamburger
                    replaces it (overflow on 14 items is unusable). */}
                <nav className="hidden md:flex gap-1 flex-wrap">
                  {navItems.map((it) => (
                    <NavLink key={it.href} href={it.href}>
                      {it.label}
                    </NavLink>
                  ))}
                </nav>
              </div>
              <div className="hidden md:flex items-center gap-3 text-sm shrink-0">
                {session.user.role === "platform_admin" && (
                  <Link
                    href="/admin"
                    className="font-mono text-[10px] tracking-wider uppercase text-terracotta hover:underline"
                  >
                    {t("adminLink")}
                  </Link>
                )}
                <span className="text-op-muted">{session.user.email}</span>
                {signOutDesktop}
              </div>
              {/* Selector de idioma — visible en desktop y móvil para que el
                  comercio pueda cambiar es/en/pt desde el panel. */}
              <LocaleSwitcher className="shrink-0" />
              <OperatorMobileMenu
                tenantName={tenant?.name ?? t("noRestaurant")}
                userEmail={session.user.email}
                isAdmin={session.user.role === "platform_admin"}
                items={navItems}
                signOutAction={signOutMobile}
              />
            </div>
          </header>
        );
      })()}
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-3 h-8 inline-flex items-center rounded-lg text-sm text-op-muted hover:text-op-text hover:bg-op-bg"
    >
      {children}
    </Link>
  );
}
