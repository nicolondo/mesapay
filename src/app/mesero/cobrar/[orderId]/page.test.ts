import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  session: null as null | { user: { id: string; role: string; restaurantId?: string } },
  activeId: "r1", order: vi.fn(), needsShift: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: async () => m.session }));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveContext: async () => m.session ? { restaurantId: m.activeId, session: m.session } : null }));
vi.mock("@/lib/db", () => ({ db: { order: { findUnique: m.order } } }));
vi.mock("@/lib/meseroShift", () => ({ meseroNeedsShiftToCharge: m.needsShift }));
vi.mock("@/app/t/[slug]/pay/[orderId]/PayFlow", () => ({ PayFlow: () => null }));
vi.mock("./MeseroNeedsShift", () => ({ MeseroNeedsShift: () => null }));
vi.mock("./ChargeLockedByAdmin", () => ({ ChargeLockedByAdmin: () => null }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("not_found"); },
  redirect: (href: string) => { throw new Error(`redirect:${href}`); },
}));
import MeseroCobrarPage from "./page";
import { MeseroNeedsShift } from "./MeseroNeedsShift";
import { ChargeLockedByAdmin } from "./ChargeLockedByAdmin";

beforeEach(() => {
  vi.clearAllMocks();
  m.activeId = "r1"; m.session = { user: { id: "u1", role: "mesero", restaurantId: "r1" } };
  m.order.mockResolvedValue({ restaurantId: "r1", restaurant: { slug: "sample", adminOnlyCharge: false } });
  m.needsShift.mockResolvedValue(false);
});
const page = (declined?: string) => MeseroCobrarPage({ params: Promise.resolve({ orderId: "o1" }), searchParams: Promise.resolve({ declined }) });

describe("waiter checkout entry", () => {
  it.each(["mesero", "operator", "platform_admin"])("rejects a %s acting on another restaurant before loading checkout", async (role) => {
    m.activeId = "other"; m.session = { user: { id: "u1", role, restaurantId: "other" } };
    await expect(page()).rejects.toThrow("not_found");
    expect(m.needsShift).not.toHaveBeenCalled();
  });
  it("preserves a terminal decline notice inside the waiter's PWA", async () => {
    expect((await page("1")).props).toMatchObject({ slug: "sample", orderId: "o1", op: "1", declined: "1" });
  });
  it("still requires the waiter shift", async () => {
    m.needsShift.mockResolvedValue(true);
    expect((await page()).type).toBe(MeseroNeedsShift);
  });
  it("still explains the admin-only charge policy", async () => {
    m.order.mockResolvedValue({ restaurantId: "r1", restaurant: { slug: "sample", adminOnlyCharge: true } });
    expect((await page()).type).toBe(ChargeLockedByAdmin);
  });
  it("still sends an unauthenticated visitor to sign in", async () => {
    m.session = null;
    await expect(page()).rejects.toThrow("redirect:/signin?callbackUrl=/mesero/cobrar/o1");
  });
});
