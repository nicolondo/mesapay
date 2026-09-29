import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/components/LocaleSwitcher", () => ({ LocaleSwitcher: () => null }));
import { MenuClient } from "./MenuClient";
const props = {
  tenant: { slug: "test", name: "Test", tagline: null, serviceMode: "table" as const },
  tableId: "", tableQrToken: "token", locationLabel: "Menu",
  categories: [{ id: "c", slug: "drinks", label: "Drinks", menuId: "m", parentId: null }],
  items: [{ id: "water", name: "Water", description: "Fresh water", categoryId: "c", priceCents: 500000, photoUrl: null, tags: [], modifiers: [], ratingAvg: 0, ratingCount: 0 }],
  activeOrder: null,
};
describe("public menu browsing", () => {
  it("shows dishes and prices without ordering or waiter actions", () => {
    const html = renderToStaticMarkup(createElement(MenuClient, { ...props, readOnly: true }));
    expect(html).toContain("Water");
    expect(html).toContain("5.000");
    expect(html).not.toContain('aria-label="addToOrder"');
    expect(html).toContain("browseOnlyLabel");
    expect(html).not.toContain("/order/");
  });
  it("preserves the selected bill when returning from browse mode", () => {
    const html = renderToStaticMarkup(createElement(MenuClient, { ...props, readOnly: true, resumeOrderId: "bill-123" }));
    expect(html).toContain('href="/t/test/menu?table=token&amp;order=bill-123"');
    expect(html).not.toContain('aria-label="addToOrder"');
  });
  it("preserves quick ordering in table mode", () => {
    const html = renderToStaticMarkup(createElement(MenuClient, props));
    expect(html).toContain('aria-label="addToOrder"');
  });
});
