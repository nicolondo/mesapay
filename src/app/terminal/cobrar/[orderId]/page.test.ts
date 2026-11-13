import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  session: null as null | { user: { id: string; role: string; restaurantId?: string } },
  activeId: "r1",
  order: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: async () => m.session }));
vi.mock("@/lib/activeRestaurant", () => ({
  getActiveContext: async () => (m.session ? { restaurantId: m.activeId, session: m.session } : null),
}));
vi.mock("@/lib/db", () => ({ db: { order: { findUnique: m.order } } }));
vi.mock("@/app/t/[slug]/pay/[orderId]/PayFlow", () => ({ PayFlow: () => null }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not_found");
  },
  redirect: (href: string) => {
    throw new Error(`redirect:${href}`);
  },
}));

import TerminalCobrarPage from "./page";
import { PayFlow } from "@/app/t/[slug]/pay/[orderId]/PayFlow";

beforeEach(() => {
  vi.clearAllMocks();
  m.activeId = "r1";
  m.session = { user: { id: "pos-1", role: "terminal", restaurantId: "r1" } };
  m.order.mockResolvedValue({ restaurantId: "r1", restaurant: { slug: "sample" } });
});

const page = (declined?: string) =>
  TerminalCobrarPage({
    params: Promise.resolve({ orderId: "o1" }),
    searchParams: Promise.resolve({ declined }),
  });

/** El `PayFlow` que arma la página (va dentro del contenedor claro). */
async function flow(declined?: string) {
  const el = await page(declined);
  const child = (el.props as { children: { type: unknown; props: Record<string, unknown> } }).children;
  expect(child.type).toBe(PayFlow);
  return child.props;
}

describe("«Cobrar» del datáfono", () => {
  it("abre el mismo checkout del staff (PayFlow en modo op) para la cuenta", async () => {
    expect(await flow()).toEqual({ slug: "sample", orderId: "o1", op: "1", declined: undefined });
  });

  it("conserva el aviso de un cobro rechazado o cancelado en el datáfono", async () => {
    expect(await flow("canceled")).toMatchObject({ declined: "canceled" });
  });

  it("el administrador también puede (cubre al datáfono)", async () => {
    m.session = { user: { id: "op-1", role: "operator", restaurantId: "r1" } };
    expect(await flow()).toMatchObject({ op: "1" });
  });

  it.each(["terminal", "operator", "platform_admin"])(
    "%s de otro comercio: 404 sin confirmar que la cuenta existe",
    async (role) => {
      m.activeId = "other";
      m.session = { user: { id: "u1", role, restaurantId: "other" } };
      await expect(page()).rejects.toThrow("not_found");
    },
  );

  it("cuenta inexistente: 404", async () => {
    m.order.mockResolvedValue(null);
    await expect(page()).rejects.toThrow("not_found");
  });

  it.each(["mesero", "kitchen", "bar", "customer"])("%s no entra al área del datáfono", async (role) => {
    m.session = { user: { id: "u1", role, restaurantId: "r1" } };
    await expect(page()).rejects.toThrow("redirect:/");
    expect(m.order).not.toHaveBeenCalled();
  });

  it("sin sesión, a iniciar sesión y de vuelta al cobro", async () => {
    m.session = null;
    await expect(page()).rejects.toThrow("redirect:/signin?callbackUrl=/terminal/cobrar/o1");
  });
});
