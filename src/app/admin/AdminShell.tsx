"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { ADMIN_ACCOUNT, ADMIN_NAV_GROUPS, resolveAdminLocation } from "@/lib/adminNav";
import { Icon } from "@/components/ui/Icon";
import { AppDialog } from "@/components/ui/AppDialog";
import { WORKSPACE_RAIL_THEME } from "@/components/ui/workspaceRailTheme";
import { ScrollerNavigationReset } from "@/components/ScrollerNavigationReset";
import { NavigationSearch } from "../operator/NavigationSearch";

export function AdminShell({ userEmail, localeSwitcher, signOut, children }: {
  userEmail: string;
  localeSwitcher: ReactNode;
  signOut: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations("opAdmin");
  const ux = useTranslations("adminWorkspace");
  const workspace = useTranslations("workspaceUi");
  const pathname = usePathname();
  const location = resolveAdminLocation(pathname);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [previousPath, setPreviousPath] = useState(pathname);
  if (previousPath !== pathname) {
    setPreviousPath(pathname);
    setDrawerOpen(false);
  }

  const searchItems = [
    ...ADMIN_NAV_GROUPS.map((group) => ({
      label: ux(`groups.${group.key}`),
      children: group.items.map((item) => ({ href: item.href, label: t(item.labelKey) })),
    })),
    { label: ux("quickActions"), children: [
      { href: "/admin/restaurants/new", label: ux("newRestaurant") },
      { href: "/admin/restaurants/eliminados", label: ux("deletedRestaurants") },
      { href: ADMIN_ACCOUNT.href, label: t(ADMIN_ACCOUNT.labelKey) },
      { href: "/operator", label: ux("operatorPortal") },
    ] },
  ];

  const rail = (
    <div className="mp-rail mp-admin-rail">
      <Link href="/admin/resumen" prefetch={false} className="mp-admin-brand" onClick={() => setDrawerOpen(false)} aria-label={ux("brandHome")}>
        <span className="mp-admin-brand-wordmark">{"MESA"}<span>{"PAY"}</span></span>
        <span className="mp-admin-brand-caption">{ux("portalName")}</span>
      </Link>

      <nav className="mp-admin-navigation" aria-label={ux("navigationLabel")}>
        {ADMIN_NAV_GROUPS.map((group) => (
          <div key={group.key} className="mp-admin-nav-group">
            {group.key !== "overview" && <p className="mp-admin-nav-label">{ux(`groups.${group.key}`)}</p>}
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                onClick={() => setDrawerOpen(false)}
                aria-current={location?.item.href === item.href ? "page" : undefined}
                className="mp-rail-link mp-admin-nav-link"
              >
                <Icon name={item.icon} />
                <span>{t(item.labelKey)}</span>
                {item.href === "/comercial" && <Icon name="arrow" className="mp-admin-external-icon" />}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <div className="mp-rail-footer mp-admin-footer">
        <Link href="/operator" prefetch={false} onClick={() => setDrawerOpen(false)} className="mp-admin-operator-link">
          <Icon name="store" />
          <span>{ux("operatorPortal")}</span>
          <Icon name="arrow" />
        </Link>
        <Link href={ADMIN_ACCOUNT.href} prefetch={false} onClick={() => setDrawerOpen(false)} aria-current={location?.item.href === ADMIN_ACCOUNT.href ? "page" : undefined} className="mp-admin-account-link" title={userEmail}>
          <span className="mp-user-avatar">{(userEmail[0] || "M").toUpperCase()}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t("navAccount")}</span>
            <span className="mp-admin-email">{userEmail}</span>
          </span>
          <Icon name="settings" width="16" height="16" />
        </Link>
        <div className="mp-admin-session-actions">{localeSwitcher}{signOut}</div>
      </div>
    </div>
  );

  return (
    <div className="op-app-shell op-admin mp-admin-shell" style={WORKSPACE_RAIL_THEME}>
      <a href="#admin-content" className="mp-skip-link">{workspace("skipContent")}</a>
      <aside className="mp-admin-sidebar print:hidden">{rail}</aside>
      <div className="mp-admin-body">
        <header className="mp-admin-topbar print:hidden">
          <button type="button" className="mp-admin-menu-button" aria-label={t("openMenu")} aria-expanded={drawerOpen} aria-haspopup="dialog" onClick={(event) => {
            // Safari does not focus a tapped button. Set the return target
            // before AppDialog records the previously focused element.
            event.currentTarget.focus({ preventScroll: true });
            setDrawerOpen(true);
          }}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="M3 5h14M3 10h14M3 15h14" /></svg>
          </button>
          <span className="mp-admin-mobile-brand">{"MESAPAY"}</span>
          <nav aria-label={ux("breadcrumbLabel")} className="mp-admin-breadcrumb">
            <span>{ux(`groups.${location?.groupKey ?? "platform"}`)}</span>
            <span aria-hidden="true">{"/"}</span>
            {location?.detailKey ? <>
              <Link href={location.item.href} prefetch={false}>{t(location.item.labelKey)}</Link>
              <span aria-hidden="true">{"/"}</span>
              <span aria-current="page">{ux(location.detailKey)}</span>
            </> : <span aria-current="page">{location ? t(location.item.labelKey) : ux("portalName")}</span>}
          </nav>
          <div className="mp-admin-topbar-actions">
            <NavigationSearch items={searchItems} />
            {pathname !== "/admin/restaurants/new" && pathname !== "/admin/restaurants" && <Link href="/admin/restaurants/new" prefetch={false} className="mp-btn mp-btn--primary mp-admin-create" aria-label={ux("newRestaurant")}>
              <Icon name="plus" width="18" height="18" /><span>{ux("newRestaurant")}</span>
            </Link>}
          </div>
        </header>
        <ScrollerNavigationReset scrollerId="admin-content" />
        <main id="admin-content" tabIndex={-1} className="mp-workspace-main mp-admin-content">{children}</main>
      </div>

      {drawerOpen && <AppDialog label={t("openMenu")} onClose={() => setDrawerOpen(false)} mobileOnly className="mp-navigation-drawer mp-admin-drawer" style={WORKSPACE_RAIL_THEME}>
        <button type="button" autoFocus className="mp-drawer-close" onClick={() => setDrawerOpen(false)} aria-label={t("closeMenu")}><Icon name="close" /></button>
        {rail}
      </AppDialog>}
    </div>
  );
}
