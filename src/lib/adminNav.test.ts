import { describe, expect, it } from "vitest";
import { ADMIN_NAV_GROUPS, resolveAdminLocation } from "./adminNav";

describe("platform administration navigation", () => {
  it("keeps every platform destination reachable exactly once", () => {
    const hrefs = ADMIN_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.href));
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(hrefs.sort()).toEqual([
      "/admin/resumen", "/admin/restaurants", "/admin/groups", "/admin/plans",
      "/admin/audit", "/admin/comisiones", "/admin/wallet", "/comercial",
      "/admin/configuracion",
    ].sort());
  });

  it.each([
    ["/admin/restaurants", "/admin/restaurants", null],
    ["/admin/restaurants/", "/admin/restaurants", null],
    ["/admin/restaurants/new", "/admin/restaurants", "newRestaurant"],
    ["/admin/restaurants/eliminados", "/admin/restaurants", "deletedRestaurants"],
    ["/admin/restaurants/local-1", "/admin/restaurants", "restaurantDetail"],
    ["/admin/restaurants/local-1/pagos", "/admin/restaurants", "restaurantPayments"],
    ["/admin/groups/group-1", "/admin/groups", "groupDetail"],
    ["/admin/resumen", "/admin/resumen", null],
    ["/admin/plans", "/admin/plans", null],
    ["/admin/wallet", "/admin/wallet", null],
    ["/admin/audit", "/admin/audit", null],
    ["/admin/configuracion", "/admin/configuracion", null],
    ["/admin/comisiones", "/admin/comisiones", null],
    ["/comercial/leads", "/comercial", null],
    ["/admin/cuenta", "/admin/cuenta", null],
  ])("resolves %s without losing its parent section", (path, href, detailKey) => {
    const location = resolveAdminLocation(path);
    expect(location?.item.href).toBe(href);
    expect(location?.detailKey).toBe(detailKey);
  });

  it.each(["/admin/restaurants-extra", "/admin/groups-other", "/unknown", "/admin", ""])(
    "does not mark a similarly named or unknown route active: %s", (path) => {
      expect(resolveAdminLocation(path)).toBeNull();
    },
  );
});
