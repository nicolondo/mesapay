import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { auth, signOut } from "@/auth";
import { db } from "@/lib/db";
import { localeTag } from "@/lib/format";
import { type Locale } from "@/i18n/config";
import { IMPERSONATE_COOKIE, getActiveContext } from "@/lib/activeRestaurant";
import { deriveMembershipStatus } from "@/lib/membership";
import { isModuleEnabled } from "@/lib/modules";
import { OperatorMobileMenu, type NavEntry } from "./OperatorMobileMenu";
import { OperatorCockpit } from "./OperatorCockpit";
import { NavDropdown } from "./NavDropdown";
import { BoardDot, BOARD_BY_HREF } from "./BoardDot";
import { computeBoardActivity, type BoardActivity } from "./boardActivity";
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

  // Aviso "algo nuevo entró" por tablero (Cocina / Bar / Salón) para el punto
  // rojo de la nav. Se recalcula en cada render del layout; como LiveRefresh
  // refresca el layout en cada evento SSE, queda casi en vivo.
  const boardActivity: BoardActivity = restaurantId
    ? await computeBoardActivity(restaurantId, tenant?.hasBar ?? false)
    : { kitchen: 0, bar: 0, floor: 0 };

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

  // ── Nav: fuente única para ambos shells (clásico + cockpit) ──────────────
  const erpItems: { href: string; label: string }[] = [
    ...(isModuleEnabled(tenant?.enabledModules, "inventory")
      ? [{ href: "/operator/inventario", label: t("navInventory") }]
      : []),
    ...(isModuleEnabled(tenant?.enabledModules, "inventory") ||
    isModuleEnabled(tenant?.enabledModules, "purchasing") ||
    isModuleEnabled(tenant?.enabledModules, "recipes")
      ? [{ href: "/operator/settings/insumos", label: t("navInsumos") }]
      : []),
    ...(isModuleEnabled(tenant?.enabledModules, "purchasing")
      ? [{ href: "/operator/compras", label: t("navPurchasing") }]
      : []),
    ...(isModuleEnabled(tenant?.enabledModules, "recipes")
      ? [{ href: "/operator/recetas", label: t("navRecipes") }]
      : []),
    ...(isModuleEnabled(tenant?.enabledModules, "accounting")
      ? [{ href: "/operator/contabilidad", label: t("navAccounting") }]
      : []),
    ...(isModuleEnabled(tenant?.enabledModules, "production")
      ? [{ href: "/operator/produccion", label: t("navProduction") }]
      : []),
    ...(isModuleEnabled(tenant?.enabledModules, "staff")
      ? [{ href: "/operator/horarios", label: t("navStaff") }]
      : []),
  ];
  const ordersGroup = [
    { href: "/operator/orders", label: t("navOrders") },
    { href: "/operator/payments", label: t("navPayments") },
    { href: "/operator/facturas", label: t("navInvoices") },
    { href: "/operator/ratings", label: t("navRatings") },
  ];
  const menuGroup = [
    { href: "/operator/menu", label: t("navMenu") },
    { href: "/operator/menus", label: t("navMenus") },
  ];
  const businessGroup = [
    { href: "/operator/reports", label: t("navClose") },
    { href: "/operator/wallet", label: t("navWallet") },
    { href: "/operator/insights", label: t("navInsights") },
  ];
  const navItems: NavEntry[] = [
    { href: "/operator", label: t("navSummary") },
    { href: "/operator/kitchen", label: t("navKitchen") },
    ...(tenant?.hasBar ? [{ href: "/operator/bar", label: t("navBar") }] : []),
    { href: "/operator/serve", label: t("navHall") },
    {
      href: "/operator/tables",
      label:
        tenant?.serviceMode === "counter" ? t("navCounter") : t("navTables"),
    },
    ...(tenant?.reservationsEnabled
      ? [{ href: "/operator/reservas", label: t("navReservations") }]
      : []),
    { label: t("navGroupOrders"), children: ordersGroup },
    { label: t("navGroupMenu"), children: menuGroup },
    ...(erpItems.length > 0
      ? [{ label: t("navErpGroup"), children: erpItems }]
      : []),
    { label: t("navGroupBusiness"), children: businessGroup },
    { href: "/operator/settings", label: t("navSettings") },
    { href: "/operator/ayuda", label: t("navHelp") },
  ];
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

  // Fecha de vencimiento localizada (para el banner "por vencer").
  const dueDateStr = tenant?.periodEndsAt
    ? new Date(tenant.periodEndsAt).toLocaleDateString(
        localeTag((await getLocale()) as Locale),
      )
    : null;

  // Banners (impersonación + membresía) — compartidos por ambos shells.
  const banners = (
    <>
      {impersonating && (
        <div className="print:hidden shrink-0 bg-terracotta text-bone px-4 md:px-6 py-2 flex items-center justify-between gap-3 text-sm flex-wrap">
          <div className="min-w-0 flex items-center gap-3 flex-wrap">
            <span className="font-mono text-[10px] tracking-wider uppercase opacity-80">
              {isGroupAdmin ? t("impGroup") : t("impImpersonating")}
            </span>
            <span className="truncate">
              {isGroupAdmin ? t("impViewing") : t("impViewingAsOperator")}{" "}
              <strong>{tenant?.name ?? "…"}</strong>
            </span>
            <GroupSwitcher siblings={siblingRestaurants} action={switchToSibling} />
          </div>
          <form action={stopImpersonating} className="shrink-0">
            <button className="font-mono text-[10px] tracking-wider uppercase underline">
              {isGroupAdmin ? t("impBackToGroup") : t("impStop")}
            </button>
          </form>
        </div>
      )}
      {membership === "vencido" && (
        <div className="print:hidden shrink-0 bg-danger/15 border-b border-danger/30 text-danger px-4 md:px-6 py-2 text-sm">
          {t.rich("membershipOverdue", { b: (chunks) => <strong>{chunks}</strong> })}
        </div>
      )}
      {membership === "por_vencer" && (
        <div className="print:hidden shrink-0 bg-[#C98A2E]/15 border-b border-[#C98A2E]/40 text-[#7F5A1F] px-4 md:px-6 py-2 text-sm">
          {dueDateStr
            ? t("membershipDueSoonDate", { date: dueDateStr })
            : t("membershipDueSoon")}
        </div>
      )}
    </>
  );

  // Shell "cockpit" = DEFAULT para todos. Escape: cookie mp_shell=classic
  // (vía ?to=classic) para volver al shell anterior si hiciera falta.
  const shellClassic =
    (await cookies()).get("mp_shell")?.value === "classic";
  if (!shellClassic) {
    return (
      <OperatorCockpit
        navItems={navItems}
        boardActivity={boardActivity}
        roleLabel={t("roleLabel", { name: tenant?.name ?? t("noRestaurant") })}
        tenantName={tenant?.name ?? t("noRestaurant")}
        userEmail={session.user.email}
        isAdmin={session.user.role === "platform_admin"}
        localeSwitcher={<LocaleSwitcher />}
        signOut={signOutMobile}
        banners={banners}
      >
        {children}
      </OperatorCockpit>
    );
  }

  return (
    <div className="op-app-shell flex flex-col bg-op-bg text-op-text overflow-hidden">
      {banners}
          <header className="print:hidden border-b border-op-border bg-op-surface shrink-0 z-10">
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
                  {navItems.map((it) =>
                    "children" in it ? (
                      <NavDropdown
                        key={it.label}
                        label={it.label}
                        items={it.children}
                      />
                    ) : (
                      <NavLink
                        key={it.href}
                        href={it.href}
                        boardActivity={boardActivity}
                      >
                        {it.label}
                      </NavLink>
                    ),
                  )}
                </nav>
              </div>
              {/* Cluster derecho: links (desktop), selector de idioma y el
                  menú (hamburguesa) juntos. Agrupados para que el switcher
                  quede pegado al menú y no flotando al centro en móvil. */}
              <div className="flex items-center gap-3 shrink-0">
                <div className="hidden md:flex items-center gap-3 text-sm">
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
                <LocaleSwitcher className="shrink-0" />
                <OperatorMobileMenu
                  tenantName={tenant?.name ?? t("noRestaurant")}
                  userEmail={session.user.email}
                  isAdmin={session.user.role === "platform_admin"}
                  items={navItems}
                  boardActivity={boardActivity}
                  signOutAction={signOutMobile}
                />
              </div>
            </div>
          </header>
      {/* Único scroller del panel. El header (arriba, fuera de este main)
          queda siempre visible. overflow-y-auto + flex-1 = patrón app-shell. */}
      <main className="flex flex-1 flex-col overflow-y-auto">{children}</main>
    </div>
  );
}

function NavLink({
  href,
  children,
  boardActivity,
}: {
  href: string;
  children: React.ReactNode;
  boardActivity?: BoardActivity;
}) {
  const board = BOARD_BY_HREF[href];
  return (
    <Link
      href={href}
      className="px-3 h-8 inline-flex items-center rounded-lg text-sm text-op-muted hover:text-op-text hover:bg-op-bg"
    >
      <span className="relative">
        {children}
        {board && boardActivity && (
          <BoardDot
            boardKey={board}
            path={href}
            activityMs={boardActivity[board]}
          />
        )}
      </span>
    </Link>
  );
}
