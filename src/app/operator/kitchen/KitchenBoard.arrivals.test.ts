import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { observeItems } from "@/lib/kitchen/newOrderChime";

const h = vi.hoisted(() => ({ ids: [] as readonly string[] }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/useVisibleEventSource", () => ({ useVisibleEventSource: vi.fn() }));
vi.mock("./NewOrderChime", () => ({ NewOrderChime: (props: { itemIds: readonly string[] }) => {
  h.ids = props.itemIds;
  return null;
} }));
import { KitchenBoard } from "./KitchenBoard";

type Round = ComponentProps<typeof KitchenBoard>["rounds"][number];
function round(id: string, itemIds: string[], tableNumber = 1): Round {
  return {
    id, seq: 1, status: "in_kitchen", placedAt: "2026-10-02T14:00:00Z", readyAt: null,
    placedByName: null, placedByRole: null,
    order: { id: `order-${tableNumber}`, shortCode: "TEST", tableNumber, servingMode: "asReady", orderType: "dineIn", pickupName: null, etaMinutes: null, readyEta: null },
    items: itemIds.map(itemId => ({ id: itemId, menuItemId: "dish", qty: 1, name: itemId, modifiers: [], notes: null, guestName: null,
      kitchenStatus: "in_kitchen", categoryKind: "main", prepMinutesSnapshot: 10,
      preparationStartedAt: "2026-10-02T14:05:00Z", preparationFirstStartedAt: "2026-10-02T14:05:00Z", servedAt: null, expediteRequestedAt: null })),
  };
}
function arrivals(rounds: Round[], mode: "kitchen" | "bar" = "kitchen") {
  renderToStaticMarkup(createElement(KitchenBoard, { tenantSlug: "test", serviceMode: "table", rounds, mode, serverNow: Date.parse("2026-10-02T14:10:00Z") }));
  return h.ids;
}
beforeEach(() => { h.ids = []; });

describe("kitchen arrivals follow dishes, not transfer rounds", () => {
  it.each(["kitchen", "bar"] as const)("%s does not announce the same dishes moved into new rounds or another account", mode => {
    const seen = observeItems(null, "", arrivals([round("original", ["dish-a", "dish-b"])], mode)).seen;
    const moved = arrivals([round("original", ["dish-b"]), round("transfer", ["dish-a"], 2)], mode);
    expect(observeItems(seen, "", moved).chime).toBe(false);
    const movedAgain = arrivals([round("original", ["dish-b"]), round("second-transfer", ["dish-a"], 3)], mode);
    expect(observeItems(seen, "", movedAgain).chime).toBe(false);
  });
  it("a genuinely new dish still announces even if it joins an existing round", () => {
    const seen = observeItems(null, "", arrivals([round("round", ["dish-a"])])).seen;
    const next = arrivals([round("round", ["dish-a", "dish-b"])]);
    expect(observeItems(seen, "", next)).toMatchObject({ chime: true, newIds: ["dish-b"] });
  });
});
