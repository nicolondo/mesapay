import { describe, expect, it } from "vitest";
import { centerInVisualViewport } from "@/lib/visualViewport";

describe("centerInVisualViewport", () => {
  it("teclado abierto (390×360) con diálogo de 420: se pega arriba y achica con scroll interno", () => {
    expect(
      centerInVisualViewport({ offsetTop: 0, height: 360, dialogHeight: 420, margin: 12 }),
    ).toEqual({ top: 12, maxHeight: 336 });
  });

  it("teclado cerrado (390×844) con diálogo de 420: centrado en la pantalla", () => {
    expect(
      centerInVisualViewport({ offsetTop: 0, height: 844, dialogHeight: 420, margin: 12 }),
    ).toEqual({ top: 212, maxHeight: 820 });
  });

  it("suma el offsetTop del viewport visual (Safari desplazó la página al enfocar)", () => {
    expect(
      centerInVisualViewport({ offsetTop: 100, height: 360, dialogHeight: 200, margin: 12 }),
    ).toEqual({ top: 180, maxHeight: 336 });
  });

  it("nunca deja el diálogo por encima del margen aunque sea justo del alto del viewport", () => {
    expect(
      centerInVisualViewport({ offsetTop: 0, height: 400, dialogHeight: 400, margin: 12 }),
    ).toEqual({ top: 12, maxHeight: 376 });
  });
});
