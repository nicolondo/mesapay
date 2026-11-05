import { describe, expect, it } from "vitest";
import { firstEnabledIndex, lastEnabledIndex, menuKeyAction, nextEnabledIndex, placeMenu } from "./menuNavigation";

const enabled = [true, false, true, true, false];

describe("teclado del menú de fila", () => {
  it("salta ítems deshabilitados y da la vuelta", () => {
    expect(nextEnabledIndex(enabled, 0, 1)).toBe(2);
    expect(nextEnabledIndex(enabled, 3, 1)).toBe(0);
    expect(nextEnabledIndex(enabled, 0, -1)).toBe(3);
    expect(firstEnabledIndex(enabled)).toBe(0);
    expect(lastEnabledIndex(enabled)).toBe(3);
    expect(nextEnabledIndex([false, false], 0, 1)).toBe(-1);
    expect(nextEnabledIndex([], 0, 1)).toBe(-1);
  });

  it("mapea flechas, Home, End, Esc y Tab", () => {
    expect(menuKeyAction("ArrowDown", 0, enabled)).toEqual({ type: "focus", index: 2 });
    expect(menuKeyAction("ArrowUp", 0, enabled)).toEqual({ type: "focus", index: 3 });
    expect(menuKeyAction("ArrowUp", -1, enabled)).toEqual({ type: "focus", index: 3 });
    expect(menuKeyAction("Home", 3, enabled)).toEqual({ type: "focus", index: 0 });
    expect(menuKeyAction("End", 0, enabled)).toEqual({ type: "focus", index: 3 });
    expect(menuKeyAction("Escape", 2, enabled)).toEqual({ type: "close", restoreFocus: true });
    expect(menuKeyAction("Tab", 2, enabled)).toEqual({ type: "close", restoreFocus: false });
    expect(menuKeyAction("a", 2, enabled)).toEqual({ type: "none" });
    expect(menuKeyAction("ArrowDown", 0, [false])).toEqual({ type: "none" });
  });
});

describe("posición del menú", () => {
  const viewport = { width: 390, height: 844 };
  const menu = { width: 220, height: 300 };
  it("se alinea a la derecha del botón y abre hacia abajo si cabe", () => {
    expect(placeMenu({ top: 100, bottom: 140, left: 330, right: 370 }, menu, viewport)).toEqual({ top: 144, left: 150 });
  });
  it("abre hacia arriba cerca del borde inferior", () => {
    expect(placeMenu({ top: 760, bottom: 800, left: 330, right: 370 }, menu, viewport)).toEqual({ top: 456, left: 150 });
  });
  it("no se sale del viewport por la izquierda ni por arriba", () => {
    expect(placeMenu({ top: 40, bottom: 80, left: 0, right: 40 }, menu, viewport).left).toBe(8);
    expect(placeMenu({ top: 200, bottom: 240, left: 300, right: 340 }, { width: 220, height: 800 }, viewport).top).toBe(36);
    expect(placeMenu({ top: 200, bottom: 240, left: 300, right: 340 }, { width: 220, height: 900 }, viewport).top).toBe(8);
  });
});
