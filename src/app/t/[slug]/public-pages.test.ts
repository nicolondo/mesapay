import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({ restaurant: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findUnique: h.restaurant } } }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("notFound"); },
  redirect: (href: string) => { throw new Error(`redirect:${href}`); },
}));

import TenantLanding from "./page";

beforeEach(() => {
  h.restaurant.mockResolvedValue({ name: "Restaurante", slug: "test", serviceMode: "table", tagline: null, tables: [{ id: "t1", number: 1, qrToken: "qr-test" }] });
});

describe("acceso a la carta pública", () => {
  it.each(["table", "counter"])("ofrece ver carta sin pedir en modo %s", async (serviceMode) => {
    h.restaurant.mockResolvedValue({ name: "Restaurante", slug: "test", serviceMode, tagline: null, tables: [{ id: "t1", number: 1, qrToken: "qr-test" }] });
    const html = renderToStaticMarkup(await TenantLanding({ params: Promise.resolve({ slug: "test" }) }));
    expect(html).toContain('href="/t/test/menu?browse=1"');
    expect(html).toContain("viewMenu");
    if (serviceMode === "counter") {
      expect(html).toContain('href="/t/test/menu?table=qr-test"');
      expect(html).toContain("startOrder");
    }
  });
});

describe("comensal sin instalación PWA", () => {
  it("anula el manifest y modo standalone heredados en mesas", async () => {
    const layout = await import("./layout");
    expect(layout.metadata).toMatchObject({ manifest: null, appleWebApp: { capable: false } });
  });

  it("anula instalación también en la carta para recoger", async () => {
    const layout = await import("../../p/[slug]/layout");
    expect(layout.metadata).toMatchObject({ manifest: null, appleWebApp: { capable: false } });
  });
});
