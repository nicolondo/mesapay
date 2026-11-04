import { describe, expect, it } from "vitest";
import { MAX_OPEN, openAll, parseOpen, serializeOpen, toggleOpen, withOpen } from "./drillState";

describe("parseOpen", () => {
  it("lee la lista separada por comas, sin vacíos ni repetidos", () => {
    expect([...parseOpen("inc,inc-ventas-8,,inc")]).toEqual(["inc", "inc-ventas-8"]);
    expect(parseOpen(null).size).toBe(0);
    expect(parseOpen("").size).toBe(0);
  });
  it("descarta ids con caracteres raros y corta en el máximo", () => {
    expect([...parseOpen("inc,<script>,iva libro,otros-retefuente-favor,iva-libro-credit_note")]).toEqual([
      "inc",
      "otros-retefuente-favor",
      "iva-libro-credit_note",
    ]);
    const many = Array.from({ length: MAX_OPEN + 10 }, (_, i) => `n${i}`).join(",");
    expect(parseOpen(many).size).toBe(MAX_OPEN);
    expect(parseOpen("x".repeat(81)).size).toBe(0);
  });
});

describe("serializeOpen", () => {
  it("ordenado (misma URL para el mismo estado) y null si no hay nada", () => {
    expect(serializeOpen(new Set(["iva", "inc-ventas-8", "inc"]))).toBe("inc,inc-ventas-8,iva");
    expect(serializeOpen(new Set())).toBeNull();
  });
  it("ida y vuelta", () => {
    const raw = "alerta-sinFactura,inc,inc-ventas-8";
    expect(serializeOpen(parseOpen(raw))).toBe(raw);
  });
});

describe("toggleOpen / openAll", () => {
  it("abre, y al cerrar un renglón cierra sus hijos (no los de otro impuesto)", () => {
    let s = toggleOpen(new Set(), "iva");
    s = toggleOpen(s, "iva-ventas-19");
    s = toggleOpen(s, "reteiva");
    expect([...s].sort()).toEqual(["iva", "iva-ventas-19", "reteiva"]);
    s = toggleOpen(s, "iva");
    expect([...s]).toEqual(["reteiva"]);
  });
  it("openAll suma sin duplicar", () => {
    expect([...openAll(new Set(["inc"]), ["inc", "inc-ventas-8", "mal id"])]).toEqual(["inc", "inc-ventas-8"]);
  });
});

describe("withOpen", () => {
  it("conserva el resto de la query", () => {
    expect(withOpen("desde=2026-10-01&hasta=2026-10-31", new Set(["inc"]))).toBe("?desde=2026-10-01&hasta=2026-10-31&abrir=inc");
    expect(withOpen("desde=2026-10-01&abrir=inc", new Set())).toBe("?desde=2026-10-01");
    expect(withOpen("", new Set())).toBe("");
  });
  it("las comas de la lista quedan legibles", () => {
    expect(withOpen("?desde=2026-10-01", new Set(["inc-ventas-8", "inc"]))).toBe("?desde=2026-10-01&abrir=inc,inc-ventas-8");
    expect(withOpen("abrir=iva", new Set(["iva", "iva-libro-sale"]))).toBe("?abrir=iva,iva-libro-sale");
  });
});
