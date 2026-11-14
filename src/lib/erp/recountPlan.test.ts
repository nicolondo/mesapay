import { describe, expect, it } from "vitest";
import { parseRecountPlan, recountReasons, recountStatus, recountSummary } from "./recountPlan";

describe("motivos para recontar un insumo", () => {
  const still = { liveQty: 10, movedSince: false };

  it("cuadró en el preliminar y no se movió → confirmado (sin motivos)", () => {
    expect(recountReasons({ preliminaryQty: 10, expectedQty: 10 }, still)).toEqual([]);
    // El cero también cuadra con cero.
    expect(recountReasons({ preliminaryQty: 0, expectedQty: 0 }, { liveQty: 0, movedSince: false })).toEqual([]);
  });

  it("faltante o sobrante en el preliminar → con diferencia", () => {
    expect(recountReasons({ preliminaryQty: 8, expectedQty: 10 }, still)).toEqual(["difference"]);
    expect(recountReasons({ preliminaryQty: 12, expectedQty: 10 }, still)).toEqual(["difference"]);
  });

  it("no se contó → sin contar (no es lo mismo que contar cero)", () => {
    expect(recountReasons({ preliminaryQty: null, expectedQty: 10 }, still)).toEqual(["uncounted"]);
    expect(recountReasons({ preliminaryQty: 0, expectedQty: 10 }, still)).toEqual(["difference"]);
  });

  it("movimientos desde que se abrió el conteo, o un saldo distinto → con movimientos", () => {
    expect(recountReasons({ preliminaryQty: 10, expectedQty: 10 }, { liveQty: 10, movedSince: true })).toEqual(["moved"]);
    expect(recountReasons({ preliminaryQty: 10, expectedQty: 10 }, { liveQty: 9, movedSince: false })).toEqual(["moved"]);
  });

  it("los motivos se acumulan", () => {
    expect(recountReasons({ preliminaryQty: 8, expectedQty: 10 }, { liveQty: 7, movedSince: true })).toEqual(["difference", "moved"]);
    expect(recountReasons({ preliminaryQty: null, expectedQty: 10 }, { liveQty: 10, movedSince: true })).toEqual(["uncounted", "moved"]);
  });
});

describe("plan guardado en el snapshot", () => {
  it("lee los motivos y descarta lo que no reconoce", () => {
    expect(parseRecountPlan({ movementCount: 3, ingredients: [], full: false, recount: { a: ["difference", "moved"], b: ["weird"], c: "x", d: [] } }))
      .toEqual({ full: false, reasons: { a: ["difference", "moved"] } });
    expect(parseRecountPlan({ recount: {}, full: true })).toEqual({ full: true, reasons: {} });
  });

  it("conteos sin plan (iniciados antes de esta regla): todo se recuenta", () => {
    for (const snapshot of [null, undefined, {}, { movementCount: 1, ingredients: [] }, { recount: [] }, { recount: "x" }, "x"]) {
      expect(parseRecountPlan(snapshot)).toBeNull();
    }
    expect(recountStatus(null, "a")).toBe("recount");
  });

  it("clasifica cada insumo y cuenta por motivo", () => {
    const plan = parseRecountPlan({ full: false, recount: { a: ["difference"], b: ["uncounted", "moved"], c: ["moved"] } });
    expect(recountStatus(plan, "a")).toBe("recount");
    expect(recountStatus(plan, "z")).toBe("confirmed");
    expect(recountSummary(plan, ["a", "b", "c", "y", "z"])).toEqual({ difference: 1, uncounted: 1, moved: 2, recount: 3, confirmed: 2 });
  });

  it("con «Recontar todo» nada queda confirmado, pero los motivos se siguen viendo", () => {
    const plan = parseRecountPlan({ full: true, recount: { a: ["difference"] } });
    expect(recountStatus(plan, "z")).toBe("recount");
    expect(recountSummary(plan, ["a", "z"])).toEqual({ difference: 1, uncounted: 0, moved: 0, recount: 2, confirmed: 0 });
  });
});
