// Teclado del menú «⋯» (patrón «menu button» de WAI-ARIA).
import { describe, expect, it } from "vitest";
import { menuButtonKeyResult, menuKeyResult, menuOpensUp } from "./menuKeys";

const LABELS = ["Ver detalle", "Ver factura", "Reenviar por correo", "Ver pedido", "Anular con nota crédito"];

describe("menuKeyResult: tecla dentro del menú abierto", () => {
  it("↓ y ↑ recorren los ítems y dan la vuelta", () => {
    expect(menuKeyResult("ArrowDown", 0, 5)).toEqual({ kind: "focus", index: 1 });
    expect(menuKeyResult("ArrowDown", 4, 5)).toEqual({ kind: "focus", index: 0 });
    expect(menuKeyResult("ArrowUp", 0, 5)).toEqual({ kind: "focus", index: 4 });
    expect(menuKeyResult("ArrowUp", 3, 5)).toEqual({ kind: "focus", index: 2 });
  });

  it("sin ítem enfocado, ↓ va al primero y ↑ al último", () => {
    expect(menuKeyResult("ArrowDown", -1, 5)).toEqual({ kind: "focus", index: 0 });
    expect(menuKeyResult("ArrowUp", -1, 5)).toEqual({ kind: "focus", index: 4 });
  });

  it("Inicio / Fin (y RePág / AvPág) van al primero y al último", () => {
    expect(menuKeyResult("Home", 3, 5)).toEqual({ kind: "focus", index: 0 });
    expect(menuKeyResult("End", 1, 5)).toEqual({ kind: "focus", index: 4 });
    expect(menuKeyResult("PageUp", 3, 5)).toEqual({ kind: "focus", index: 0 });
    expect(menuKeyResult("PageDown", 1, 5)).toEqual({ kind: "focus", index: 4 });
  });

  it("Esc cierra y consume la tecla; Tab cierra y deja seguir el foco", () => {
    expect(menuKeyResult("Escape", 2, 5)).toEqual({ kind: "close", via: "escape" });
    expect(menuKeyResult("Tab", 2, 5)).toEqual({ kind: "close", via: "tab" });
    expect(menuKeyResult("Escape", -1, 0)).toEqual({ kind: "close", via: "escape" });
  });

  it("una letra salta al próximo ítem que empieza con ella, sin tildes ni mayúsculas, y da la vuelta", () => {
    expect(menuKeyResult("r", 0, 5, LABELS)).toEqual({ kind: "focus", index: 2 });
    expect(menuKeyResult("v", 1, 5, LABELS)).toEqual({ kind: "focus", index: 3 });
    expect(menuKeyResult("v", 3, 5, LABELS)).toEqual({ kind: "focus", index: 0 });
    expect(menuKeyResult("A", -1, 5, LABELS)).toEqual({ kind: "focus", index: 4 });
    expect(menuKeyResult("á", 0, 5, LABELS)).toEqual({ kind: "focus", index: 4 });
  });

  it("lo demás no es del menú (Enter y Espacio los resuelve el control enfocado)", () => {
    expect(menuKeyResult("Enter", 1, 5, LABELS)).toEqual({ kind: "none" });
    expect(menuKeyResult(" ", 1, 5, LABELS)).toEqual({ kind: "none" });
    expect(menuKeyResult("z", 1, 5, LABELS)).toEqual({ kind: "none" });
    expect(menuKeyResult("ArrowLeft", 1, 5, LABELS)).toEqual({ kind: "none" });
    expect(menuKeyResult("ArrowDown", 0, 0)).toEqual({ kind: "none" });
  });
});

describe("menuButtonKeyResult: tecla sobre el botón «⋯» cerrado", () => {
  it("↓ abre en el primer ítem, ↑ en el último; el resto no abre (Enter/Espacio son el click)", () => {
    expect(menuButtonKeyResult("ArrowDown")).toBe("first");
    expect(menuButtonKeyResult("ArrowUp")).toBe("last");
    expect(menuButtonKeyResult("Enter")).toBeNull();
    expect(menuButtonKeyResult("Tab")).toBeNull();
  });
});

describe("menuOpensUp: hacia dónde abre", () => {
  it("abajo si entra", () => {
    expect(menuOpensUp({ anchorTop: 100, anchorBottom: 132, menuHeight: 220, viewportHeight: 900 })).toBe(false);
  });
  it("arriba si abajo no entra y arriba hay más lugar (última fila)", () => {
    expect(menuOpensUp({ anchorTop: 800, anchorBottom: 832, menuHeight: 220, viewportHeight: 900 })).toBe(true);
  });
  it("abajo si tampoco entra arriba y abajo hay más lugar", () => {
    expect(menuOpensUp({ anchorTop: 120, anchorBottom: 152, menuHeight: 400, viewportHeight: 420 })).toBe(false);
  });
});
