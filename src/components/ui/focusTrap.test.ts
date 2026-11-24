import { describe, expect, it } from "vitest";

import { isInsideNestedDialog } from "./focusTrap";

/**
 * La guarda del trap de foco. Sólo debe apartarse cuando el evento nace
 * dentro de OTRO diálogo modal — uno que el navegador ya contiene por su
 * cuenta. Si se aparta con el diálogo propio, el trap no corre nunca.
 */

/** Un elemento de mentira: `closest` devuelve el diálogo que lo contiene. */
function elementIn(dialog: object | null) {
  return { closest: (selector: string) => (selector === "dialog[open]" ? dialog : null) };
}

describe("isInsideNestedDialog", () => {
  it("un control del PROPIO diálogo no cuenta como anidado", () => {
    // El caso que rompía AppDialog: su contenedor es el `<dialog>`, así
    // que `closest` desde cualquier botón suyo lo devuelve a él mismo.
    const appDialog = { tag: "dialog" };
    expect(isInsideNestedDialog(elementIn(appDialog), appDialog)).toBe(false);
  });

  it("un control de un diálogo de ENCIMA sí cuenta", () => {
    const sheet = { tag: "div" };
    const nested = { tag: "dialog" };
    expect(isInsideNestedDialog(elementIn(nested), sheet)).toBe(true);
  });

  it("sin ningún diálogo alrededor, no cuenta", () => {
    expect(isInsideNestedDialog(elementIn(null), { tag: "div" })).toBe(false);
  });

  it("un target que no es elemento no rompe nada", () => {
    expect(isInsideNestedDialog(null, { tag: "div" })).toBe(false);
    expect(isInsideNestedDialog(undefined, { tag: "div" })).toBe(false);
    expect(isInsideNestedDialog({}, { tag: "div" })).toBe(false);
  });
});
