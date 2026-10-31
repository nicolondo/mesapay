import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/components/LocaleSwitcher", () => ({ LocaleSwitcher: () => null }));
import { CartBar, MenuClient } from "./MenuClient";
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

const cartBarProps = {
  lines: [{ key: "water", menuItemId: "water", name: "Water", priceCents: 500000, qty: 1, selections: {} }],
  menuItems: props.items, subtotal: 500000, totalQty: 1,
  onQty: vi.fn(), onRemove: vi.fn(), onNote: vi.fn(), submitting: false, onSend: vi.fn(),
  appendingTo: null, split: false, servingMode: "asReady" as const, onServingModeChange: vi.fn(),
  showServingMode: true, prepay: false,
};
/** Etiqueta de apertura del elemento que lleva `attr`. */
function tagWith(html: string, attr: string) {
  const at = html.indexOf(attr);
  return at < 0 ? "" : html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}
describe("aviso «¡Agregado!» del carrito", () => {
  it("en el dock partido apunta al botón del carrito, el de la derecha", () => {
    // Dock partido = hay pedido activo: su botón va a la izquierda y CartBar
    // es la columna derecha. El aviso vive DENTRO de esa columna.
    const html = renderToStaticMarkup(createElement(CartBar, { ...cartBarProps, split: true, appendingTo: "A1B2", hintPhase: "shown" }));
    expect(tagWith(html, "data-cart-column")).toContain("flex-1 min-w-0 basis-0 relative");
    expect(html.match(/data-cart-hint-arrow/g)).toHaveLength(1);
    // El pico queda centrado sobre la columna del carrito…
    expect(tagWith(html, "data-cart-hint-arrow")).toContain("left-1/2 size-4 -translate-x-1/2 rotate-45");
    // …y el cuerpo se apoya en el borde derecho y crece hacia la izquierda.
    expect(tagWith(html, "data-cart-hint=")).toContain('data-cart-hint-align="end"');
    expect(tagWith(html, "data-cart-hint=")).toContain("justify-end");
    // Burbuja antes del botón y anillo adentro del botón del carrito.
    const button = html.indexOf("<button");
    expect(html.indexOf("data-cart-hint-arrow")).toBeLessThan(button);
    expect(html.indexOf("data-cart-hint-ring")).toBeGreaterThan(button);
    expect(html.indexOf("data-cart-hint-ring")).toBeLessThan(html.indexOf("reviewAndSend"));
    expect(html).toContain("cartHintTitle");
    expect(html).toContain("cartHintSend");
  });
  it("con el carrito solo, la burbuja se centra sobre el botón", () => {
    const html = renderToStaticMarkup(createElement(CartBar, { ...cartBarProps, hintPhase: "shown" }));
    expect(tagWith(html, "data-cart-hint=")).toContain('data-cart-hint-align="center"');
    expect(tagWith(html, "data-cart-hint=")).toContain("justify-center");
    expect(html).toContain("data-cart-hint-ring");
  });
  it("en mostrador el aviso habla de pagar", () => {
    const html = renderToStaticMarkup(createElement(CartBar, { ...cartBarProps, prepay: true, hintPhase: "shown" }));
    expect(html).toContain("cartHintPay");
    expect(html).not.toContain("cartHintSend");
  });
  it("no tapa ni bloquea toques y anuncia por role=status", () => {
    const html = renderToStaticMarkup(createElement(CartBar, { ...cartBarProps, hintPhase: "shown" }));
    expect(tagWith(html, 'role="status"')).toContain('aria-live="polite"');
    expect(tagWith(html, 'role="status"')).toContain("pointer-events-none");
    expect(tagWith(html, "data-cart-hint-ring")).toContain("pointer-events-none");
  });
  it("en el fundido de salida sigue apuntando, desvaneciéndose", () => {
    const html = renderToStaticMarkup(createElement(CartBar, { ...cartBarProps, hintPhase: "leaving" }));
    expect(tagWith(html, "data-cart-hint=")).toContain("cart-hint-out");
    expect(tagWith(html, "data-cart-hint-ring")).toContain("cart-hint-out");
  });
  it("sin aviso deja la región de estado vacía y el botón sin anillo", () => {
    for (const hintPhase of ["hidden", "armed"] as const) {
      const html = renderToStaticMarkup(createElement(CartBar, { ...cartBarProps, hintPhase }));
      expect(html).toContain('role="status"');
      expect(html).not.toContain("data-cart-hint=");
      expect(html).not.toContain("data-cart-hint-ring");
      expect(html).not.toContain("cartHintTitle");
    }
  });
  it("el menú recién cargado no muestra el aviso", () => {
    const html = renderToStaticMarkup(createElement(MenuClient, props));
    expect(html).not.toContain("cartHintTitle");
  });
});
