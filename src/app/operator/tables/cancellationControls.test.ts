import { createElement, type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import es from "../../../../messages/es.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../kitchen/NewOrderChime", () => ({ NewOrderChime: () => null }));
import { TableDetailSheet } from "./TableDetailSheet";
import { KitchenBoard } from "../kitchen/KitchenBoard";
import { TableActions } from "./TableActions";

function render(child: ReactElement) {
  // NextIntl requires children in its props even with createElement's API.
  // eslint-disable-next-line react/no-children-prop -- Required by the provider's props type.
  return renderToStaticMarkup(createElement(NextIntlClientProvider,
    { locale: "es", timeZone: "America/Bogota", messages: es, children: child }));
}
const started = "2026-10-02T17:00:00.000Z";
function table(role: string, state: "placed" | "in_kitchen" | "ready", served = false, first: string | null = null, manual = false) {
  const props = {
    orderId: "order", shortCode: "TEST", tableLabel: "Mesa 1", tableNumber: 1,
    tableId: "table", freeTables: [], allTables: [], open: true, hideTrigger: true,
    orderStatus: "placed", viewerRole: role, manual,
    compPolicy: { locked: false, allowedRoles: ["operator", "mesero"] },
    initialRounds: [{ id: "round", seq: 1, status: state, placedAt: started, placedByName: null, placedByRole: null,
      items: [{ id: "item", menuItemId: "dish", name: "Patacones", qty: 1, priceCents: 2500000,
        kitchenStatus: state, preparationStartedAt: state === "in_kitchen" ? started : null,
        preparationFirstStartedAt: first, servedAt: served ? started : null,
        expediteRequestedAt: null, guestName: null, notes: null }] }],
  };
  return render(createElement(TableDetailSheet, props as unknown as ComponentProps<typeof TableDetailSheet>));
}
function activeButton(html: string, label: string) {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .some((m) => !/\sdisabled(?:=|\s|$)/.test(m[1]) && m[2].replace(/<[^>]+>/g, "").trim() === label);
}

describe("cancellation controls enforce preparation boundary", () => {
  it("keeps waiter cancellation before preparation", () => {
    expect(activeButton(table("mesero", "placed"), es.opTables.cancelItem)).toBe(true);
  });
  it.each(["in_kitchen", "ready"] as const)("disables waiter cancellation in %s", (state) => {
    expect(activeButton(table("mesero", state), es.opTables.cancelItem)).toBe(false);
  });
  it("does not let configured waiter comps override served-dish restriction", () => {
    expect(activeButton(table("mesero", "ready", true), es.opTables.compItem)).toBe(false);
  });
  it("keeps reset dishes protected by first preparation timestamp", () => {
    expect(activeButton(table("mesero", "placed", false, started), es.opTables.cancelItem)).toBe(false);
  });
  it.each(["operator", "platform_admin", "group_admin"])("keeps administrator %s item controls", (role) => {
    expect(activeButton(table(role, "in_kitchen"), es.opTables.cancelItem)).toBe(true);
    expect(activeButton(table(role, "ready", true), es.opTables.compItem)).toBe(true);
  });
  it("does not mistake technical manual-invoice serving for preparation", () => {
    expect(activeButton(table("mesero", "ready", true, null, true), es.opTables.cancelItem)).toBe(true);
  });
  it("uses item-derived permission for coarse whole-order action", () => {
    const html = render(createElement(TableActions, {
      orderId: "order", tenantSlug: "test", status: "placed", outstandingCents: 1,
      canCancelOrder: false,
    } as unknown as ComponentProps<typeof TableActions>));
    expect(activeButton(html, es.opTables.actionsCancel)).toBe(false);
  });
  it.each(["kitchen", "bar", "mesero"])("does not offer prepared rejection to %s", (role) => {
    const html = render(createElement(KitchenBoard, {
      tenantSlug: "test", serviceMode: "table", viewerRole: role, serverNow: Date.parse(started),
      rounds: [{ id: "round", seq: 1, status: "in_kitchen", placedAt: started, readyAt: null,
        placedByName: null, placedByRole: null,
        order: { id: "order", shortCode: "TEST", tableNumber: 1, tableKind: "regular", servingMode: "asReady", orderType: "dineIn", pickupName: null, etaMinutes: null, readyEta: null },
        items: [{ id: "item", menuItemId: "dish", qty: 1, name: "Patacones", modifiers: [], notes: null,
          guestName: null, kitchenStatus: "in_kitchen", categoryKind: "side", prepMinutesSnapshot: 10,
          preparationStartedAt: started, preparationFirstStartedAt: started, servedAt: null, expediteRequestedAt: null }] }],
    } as unknown as ComponentProps<typeof KitchenBoard>));
    expect(activeButton(html, es.kitchen.cancel)).toBe(false);
    expect(activeButton(html, es.kitchen.ready)).toBe(true);
  });
});
