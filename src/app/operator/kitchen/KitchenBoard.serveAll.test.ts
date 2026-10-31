import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/lib/useVisibleEventSource", () => ({ useVisibleEventSource: vi.fn() }));
// El encabezado real necesita Web Audio; acá sólo importa la fila de acciones.
vi.mock("./NewOrderChime", () => ({
  NewOrderChime: (props: { actions?: ReactNode }) =>
    createElement("header", { "data-testid": "board-header" }, props.actions),
}));
import { KitchenBoard } from "./KitchenBoard";

type Round = ComponentProps<typeof KitchenBoard>["rounds"][number];

function round(id: string, served: boolean): Round {
  return {
    id, seq: 1, status: "ready", placedAt: "2026-10-31T19:00:00Z", readyAt: "2026-10-31T19:05:00Z",
    placedByName: null, placedByRole: null,
    order: { id: `order-${id}`, shortCode: "TEST", tableNumber: 3, servingMode: "asReady", orderType: "dineIn", pickupName: null, etaMinutes: null, readyEta: null },
    items: [{
      id: `item-${id}`, menuItemId: "dish", qty: 1, name: "Plato", modifiers: [], notes: null, guestName: null,
      kitchenStatus: "ready", categoryKind: "main", prepMinutesSnapshot: 10,
      preparationStartedAt: "2026-10-31T19:01:00Z", preparationFirstStartedAt: "2026-10-31T19:01:00Z",
      servedAt: served ? "2026-10-31T19:06:00Z" : null, expediteRequestedAt: null,
    }],
  };
}

function header(viewerRole: string | null, rounds: Round[], mode: "kitchen" | "bar" = "kitchen") {
  const html = renderToStaticMarkup(createElement(KitchenBoard, {
    tenantSlug: "test", serviceMode: "table", rounds, mode, viewerRole,
    serverNow: Date.parse("2026-10-31T19:10:00Z"),
  }));
  return html.match(/<header data-testid="board-header">([\s\S]*?)<\/header>/)?.[1] ?? "";
}

describe("«Servir todo» en el encabezado del tablero", () => {
  it.each(["operator", "group_admin", "platform_admin"])("%s lo ve en cocina y en el bar", (role) => {
    expect(header(role, [round("a", false)])).toContain("serveAll");
    expect(header(role, [round("a", false)], "bar")).toContain("serveAll");
  });

  it.each(["kitchen", "bar", "mesero", "terminal", null])("%s no lo ve (ni deshabilitado)", (role) => {
    const html = header(role, [round("a", false)], role === "bar" ? "bar" : "kitchen");
    expect(html).not.toContain("serveAll");
    expect(html).toBe("");
  });

  it("sin nada pendiente no aparece", () => {
    expect(header("operator", [round("a", true)])).not.toContain("serveAll");
  });
});
