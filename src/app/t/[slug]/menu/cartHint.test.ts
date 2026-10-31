import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CART_HINT_FADE_MS,
  CART_HINT_VISIBLE_MS,
  createCartHintController,
  isCartHintVisible,
  shouldShowCartHint,
  type CartHintPhase,
} from "./cartHint";

describe("shouldShowCartHint — cuándo sale el aviso del carrito", () => {
  it("sale cuando el carrito pasa de vacío a tener el primer plato", () => {
    expect(shouldShowCartHint(0, 1)).toBe(true);
  });

  it("no sale con el segundo plato ni los siguientes", () => {
    expect(shouldShowCartHint(1, 2)).toBe(false);
    expect(shouldShowCartHint(2, 3)).toBe(false);
  });

  it("no sale al recargar la página con un carrito ya armado", () => {
    // null = primer valor después de hidratar (carrito restaurado).
    expect(shouldShowCartHint(null, 3)).toBe(false);
    expect(shouldShowCartHint(null, 0)).toBe(false);
  });

  it("vuelve a salir si el carrito se vació y se llena de nuevo", () => {
    expect(shouldShowCartHint(1, 0)).toBe(false);
    expect(shouldShowCartHint(0, 1)).toBe(true);
  });

  it("no sale cuando el carrito se queda igual (volver de la hoja sin agregar)", () => {
    expect(shouldShowCartHint(0, 0)).toBe(false);
    expect(shouldShowCartHint(2, 2)).toBe(false);
  });
});

describe("createCartHintController — cuánto dura", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup({ dockVisible = true, initialCount = 0 } = {}) {
    const phases: CartHintPhase[] = [];
    const hint = createCartHintController((p) => phases.push(p));
    hint.setDockVisible(dockVisible);
    // Primer valor tras hidratar: fija la referencia.
    hint.cartCountChanged(initialCount);
    return { hint, phases };
  }

  it("con el primer plato se ve 2 s y después se desvanece", () => {
    const { hint, phases } = setup();
    hint.cartCountChanged(1);
    expect(hint.phase).toBe("shown");
    expect(isCartHintVisible(hint.phase)).toBe(true);

    vi.advanceTimersByTime(CART_HINT_VISIBLE_MS - 1);
    expect(hint.phase).toBe("shown");
    vi.advanceTimersByTime(1);
    expect(hint.phase).toBe("leaving");
    expect(isCartHintVisible(hint.phase)).toBe(true);

    vi.advanceTimersByTime(CART_HINT_FADE_MS);
    expect(hint.phase).toBe("hidden");
    expect(phases).toEqual(["armed", "shown", "leaving", "hidden"]);
    expect(CART_HINT_VISIBLE_MS).toBe(2000);
  });

  it("el segundo plato no lo vuelve a mostrar ni le alarga el tiempo", () => {
    const { hint, phases } = setup();
    hint.cartCountChanged(1);
    vi.advanceTimersByTime(1500);
    hint.cartCountChanged(2);
    vi.advanceTimersByTime(500);
    expect(hint.phase).toBe("leaving");
    vi.advanceTimersByTime(CART_HINT_FADE_MS);
    hint.cartCountChanged(3);
    vi.advanceTimersByTime(10_000);
    expect(phases).toEqual(["armed", "shown", "leaving", "hidden"]);
  });

  it("recargar con el carrito armado no lo muestra", () => {
    const { hint, phases } = setup({ initialCount: 2 });
    hint.cartCountChanged(3);
    vi.advanceTimersByTime(10_000);
    expect(hint.phase).toBe("hidden");
    expect(phases).toEqual([]);
  });

  it("si el carrito se vacía y se vuelve a llenar, sale otra vez", () => {
    const { hint, phases } = setup({ initialCount: 2 });
    hint.cartCountChanged(0);
    hint.cartCountChanged(1);
    expect(hint.phase).toBe("shown");
    vi.advanceTimersByTime(CART_HINT_VISIBLE_MS + CART_HINT_FADE_MS);
    expect(phases).toEqual(["armed", "shown", "leaving", "hidden"]);
  });

  it("vaciar el carrito con el aviso en pantalla lo quita", () => {
    const { hint } = setup();
    hint.cartCountChanged(1);
    hint.cartCountChanged(0);
    expect(hint.phase).toBe("hidden");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tocar el carrito lo cierra enseguida, sin fundido, y cancela el temporizador", () => {
    const { hint, phases } = setup();
    hint.cartCountChanged(1);
    vi.advanceTimersByTime(800);
    hint.dismiss();
    expect(hint.phase).toBe("hidden");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(phases).toEqual(["armed", "shown", "hidden"]);
  });

  it("agregado desde la hoja del plato: espera a que la hoja se cierre y recién ahí cuenta los 2 s", () => {
    // La hoja del plato está abierta: el dock (y el botón) no se pintan.
    const { hint, phases } = setup({ dockVisible: false });
    hint.cartCountChanged(1);
    expect(hint.phase).toBe("armed");
    expect(isCartHintVisible(hint.phase)).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(hint.phase).toBe("armed");

    hint.setDockVisible(true);
    expect(hint.phase).toBe("shown");
    vi.advanceTimersByTime(CART_HINT_VISIBLE_MS);
    expect(hint.phase).toBe("leaving");
    vi.advanceTimersByTime(CART_HINT_FADE_MS);
    expect(phases).toEqual(["armed", "shown", "leaving", "hidden"]);
  });

  it("abrir otro plato con el aviso en pantalla lo quita, y al volver sin agregar no reaparece", () => {
    const { hint, phases } = setup();
    hint.cartCountChanged(1);
    hint.setDockVisible(false);
    expect(hint.phase).toBe("hidden");
    hint.setDockVisible(true);
    hint.cartCountChanged(1);
    vi.advanceTimersByTime(10_000);
    expect(hint.phase).toBe("hidden");
    expect(phases).toEqual(["armed", "shown", "hidden"]);
  });

  it("dispose limpia los temporizadores y no avisa más", () => {
    const { hint, phases } = setup();
    hint.cartCountChanged(1);
    hint.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    hint.cartCountChanged(0);
    hint.cartCountChanged(1);
    expect(phases).toEqual(["armed", "shown"]);
  });
});
