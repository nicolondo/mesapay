import type { IconName } from "@/components/ui/Icon";

type AdminNavItem = { href: string; labelKey: string; icon: IconName };
type AdminNavGroup = { key: "overview" | "merchants" | "finance" | "platform"; items: readonly AdminNavItem[] };

/** One destination list for the sidebar, mobile drawer and section search. */
export const ADMIN_NAV_GROUPS: readonly AdminNavGroup[] = [
  { key: "overview", items: [{ href: "/admin/resumen", labelKey: "navSummary", icon: "overview" }] },
  { key: "merchants", items: [
    { href: "/admin/restaurants", labelKey: "navRestaurants", icon: "store" },
    { href: "/admin/groups", labelKey: "navGroups", icon: "groups" },
    { href: "/comercial", labelKey: "navCrm", icon: "business" },
  ] },
  { key: "finance", items: [
    { href: "/admin/wallet", labelKey: "navWallet", icon: "wallet" },
    { href: "/admin/comisiones", labelKey: "navComisiones", icon: "business" },
    { href: "/admin/plans", labelKey: "navPlans", icon: "orders" },
  ] },
  { key: "platform", items: [
    { href: "/admin/configuracion", labelKey: "navConfig", icon: "settings" },
    { href: "/admin/audit", labelKey: "navAudit", icon: "audit" },
  ] },
];

export const ADMIN_ACCOUNT: AdminNavItem = { href: "/admin/cuenta", labelKey: "navAccount", icon: "user" };
type DetailKey = "newRestaurant" | "deletedRestaurants" | "restaurantDetail" | "restaurantPayments" | "groupDetail";

export function resolveAdminLocation(pathname: string): {
  item: AdminNavItem;
  groupKey: AdminNavGroup["key"];
  detailKey: DetailKey | null;
} | null {
  const path = pathname.replace(/\/+$/, "");
  if (path === ADMIN_ACCOUNT.href) return { item: ADMIN_ACCOUNT, groupKey: "platform", detailKey: null };
  for (const group of ADMIN_NAV_GROUPS) {
    const item = group.items.find(({ href }) => path === href || path.startsWith(`${href}/`));
    if (!item) continue;
    const suffix = path.slice(item.href.length);
    let detailKey: DetailKey | null = null;
    if (item.href === "/admin/restaurants" && suffix) {
      detailKey = suffix === "/new" ? "newRestaurant"
        : suffix === "/eliminados" ? "deletedRestaurants"
        : suffix.endsWith("/pagos") ? "restaurantPayments" : "restaurantDetail";
    } else if (item.href === "/admin/groups" && suffix) {
      detailKey = "groupDetail";
    }
    return { item, groupKey: group.key, detailKey };
  }
  return null;
}
