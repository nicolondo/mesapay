import { describe, expect, it } from "vitest";
import {
  ROW_INTERACTIVE_SELECTOR,
  detailNavAction,
  detailPosition,
  isEditableTarget,
  rowClickOpensDetail,
} from "./purchaseListNav";

// Imita a Element.closest sin DOM: `inside` dice si el clic cayó dentro de
// un control interactivo (botón, enlace, campo…).
function fakeTarget(inside: boolean) {
  return {
    closest: (selector: string) => {
      expect(selector).toBe(ROW_INTERACTIVE_SELECTOR);
      return inside ? {} : null;
    },
  };
}

describe("rowClickOpensDetail (fila entera clicable)", () => {
  it("abre con un clic en una celda cualquiera", () => {
    expect(rowClickOpensDetail(fakeTarget(false), "")).toBe(true);
    expect(rowClickOpensDetail(fakeTarget(false), null)).toBe(true);
    expect(rowClickOpensDetail(fakeTarget(false), undefined)).toBe(true);
  });

  it("NO abre cuando el clic cae en un control interno de la fila", () => {
    expect(rowClickOpensDetail(fakeTarget(true), "")).toBe(false);
  });

  it("NO abre cuando hay texto seleccionado (copiar con el mouse)", () => {
    expect(rowClickOpensDetail(fakeTarget(false), "FE-00123")).toBe(false);
  });

  it("abre aunque el target no tenga closest (p. ej. un nodo de texto raro)", () => {
    expect(rowClickOpensDetail({}, "")).toBe(true);
    expect(rowClickOpensDetail(null, "")).toBe(true);
  });
});

describe("detailNavAction (atajos con el detalle abierto)", () => {
  const body = { tagName: "DIV" };

  it("← anterior, → siguiente, Esc cierra", () => {
    expect(detailNavAction({ key: "ArrowLeft", target: body })).toBe("prev");
    expect(detailNavAction({ key: "ArrowRight", target: body })).toBe("next");
    expect(detailNavAction({ key: "Escape", target: body })).toBe("close");
  });

  it("otras teclas (incluidas ↑/↓, que son del scroll) no hacen nada", () => {
    expect(detailNavAction({ key: "ArrowUp", target: body })).toBeNull();
    expect(detailNavAction({ key: "ArrowDown", target: body })).toBeNull();
    expect(detailNavAction({ key: "Enter", target: body })).toBeNull();
    expect(detailNavAction({ key: "a", target: body })).toBeNull();
  });

  it("NO dispara con el foco en un input/textarea/select o contenteditable", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(detailNavAction({ key: "ArrowLeft", target: { tagName } })).toBeNull();
      expect(detailNavAction({ key: "Escape", target: { tagName } })).toBeNull();
    }
    expect(detailNavAction({ key: "ArrowRight", target: { tagName: "DIV", isContentEditable: true } })).toBeNull();
  });

  it("NO dispara con modificadores (Cmd+← es «atrás» del navegador)", () => {
    expect(detailNavAction({ key: "ArrowLeft", metaKey: true, target: body })).toBeNull();
    expect(detailNavAction({ key: "ArrowRight", altKey: true, target: body })).toBeNull();
    expect(detailNavAction({ key: "Escape", ctrlKey: true, target: body })).toBeNull();
    expect(detailNavAction({ key: "ArrowLeft", shiftKey: true, target: body })).toBeNull();
  });

  it("NO dispara con otro sheet encima (suspended)", () => {
    expect(detailNavAction({ key: "Escape", target: body }, { suspended: true })).toBeNull();
    expect(detailNavAction({ key: "ArrowRight", target: body }, { suspended: true })).toBeNull();
  });
});

describe("isEditableTarget", () => {
  it("distingue campos de lo demás", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});

describe("detailPosition (posición y vecinos según la lista visible)", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("sigue el orden de la lista visible (la que ya viene filtrada y ordenada)", () => {
    const p = detailPosition(rows, "b", { from: 1, total: 3 });
    expect(p).toEqual({ pos: 2, total: 3, prevId: "a", nextId: "c" });
  });

  it("si los filtros/orden cambian las filas, los vecinos cambian con ellas", () => {
    // Misma compra, otra lista (p. ej. filtrada por proveedor y otro orden).
    const filtered = [{ id: "c" }, { id: "b" }];
    const p = detailPosition(filtered, "b", { from: 1, total: 2 });
    expect(p).toEqual({ pos: 2, total: 2, prevId: "c", nextId: null });
  });

  it("la posición es global: cuenta las páginas anteriores vía `from`", () => {
    // Página 2 (25 por página): la primera fila visible es la nº 26.
    const p = detailPosition(rows, "c", { from: 26, total: 60 });
    expect(p).toEqual({ pos: 28, total: 60, prevId: "b", nextId: null });
  });

  it("en los extremos de la página no hay vecino (sin dar la vuelta)", () => {
    expect(detailPosition(rows, "a", { from: 1, total: 3 })?.prevId).toBeNull();
    expect(detailPosition(rows, "c", { from: 1, total: 3 })?.nextId).toBeNull();
  });

  it("null si la compra abierta no está en la página visible (enlace ?oc=)", () => {
    expect(detailPosition(rows, "zzz", { from: 1, total: 3 })).toBeNull();
    expect(detailPosition([], "a", { from: 0, total: 0 })).toBeNull();
  });
});
