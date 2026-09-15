import { describe, expect, it } from "vitest";
import {
  deriveRoundStatus,
  itemKitchenStatusData,
  roundStatusData,
} from "./roundStatus";

/**
 * Reglas puras del tablero, compartidas por el PATCH de order-items y el
 * marchado automático. Son las reglas que vivían inline en la ruta; los
 * casos de acá son exactamente los que esa ruta cubría.
 */
const NOW = new Date("2026-09-14T20:00:00Z");
const EARLIER = new Date("2026-09-14T19:30:00Z");

describe("itemKitchenStatusData", () => {
  it("arranca el cronómetro la primera vez que el ítem entra a preparación", () => {
    expect(
      itemKitchenStatusData({ preparationStartedAt: null }, "in_kitchen", NOW),
    ).toEqual({ kitchenStatus: "in_kitchen", preparationStartedAt: NOW });
  });

  it("no re-arranca el cronómetro si ya estaba corriendo", () => {
    expect(
      itemKitchenStatusData(
        { preparationStartedAt: EARLIER },
        "in_kitchen",
        NOW,
      ),
    ).toEqual({ kitchenStatus: "in_kitchen" });
  });

  it("volver a 'por preparar' borra el cronómetro", () => {
    expect(
      itemKitchenStatusData({ preparationStartedAt: EARLIER }, "placed", NOW),
    ).toEqual({ kitchenStatus: "placed", preparationStartedAt: null });
  });

  it("marcar listo no toca el cronómetro", () => {
    expect(
      itemKitchenStatusData({ preparationStartedAt: EARLIER }, "ready", NOW),
    ).toEqual({ kitchenStatus: "ready" });
  });
});

describe("deriveRoundStatus", () => {
  it("es el eslabón más débil: placed > in_kitchen > ready", () => {
    expect(deriveRoundStatus(["ready", "in_kitchen", "placed"])).toBe("placed");
    expect(deriveRoundStatus(["ready", "in_kitchen"])).toBe("in_kitchen");
    expect(deriveRoundStatus(["ready", "ready"])).toBe("ready");
  });

  it("sin ítems vivos la ronda cuenta como lista", () => {
    expect(deriveRoundStatus([])).toBe("ready");
  });
});

describe("roundStatusData", () => {
  it("sella kitchenStartedAt sólo la primera vez que entra a preparación", () => {
    expect(
      roundStatusData({ kitchenStartedAt: null, readyAt: null }, "in_kitchen", NOW),
    ).toEqual({
      data: { status: "in_kitchen", kitchenStartedAt: NOW },
      becameReady: false,
    });
    expect(
      roundStatusData(
        { kitchenStartedAt: EARLIER, readyAt: null },
        "in_kitchen",
        NOW,
      ),
    ).toEqual({ data: { status: "in_kitchen" }, becameReady: false });
  });

  it("sella readyAt y avisa la primera vez que queda lista", () => {
    expect(
      roundStatusData({ kitchenStartedAt: EARLIER, readyAt: null }, "ready", NOW),
    ).toEqual({ data: { status: "ready", readyAt: NOW }, becameReady: true });
    expect(
      roundStatusData({ kitchenStartedAt: EARLIER, readyAt: EARLIER }, "ready", NOW),
    ).toEqual({ data: { status: "ready" }, becameReady: false });
  });

  it("devolver un ítem desde listo limpia readyAt", () => {
    expect(
      roundStatusData(
        { kitchenStartedAt: EARLIER, readyAt: EARLIER },
        "in_kitchen",
        NOW,
      ),
    ).toEqual({ data: { status: "in_kitchen", readyAt: null }, becameReady: false });
  });
});
