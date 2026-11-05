import { describe, expect, it } from "vitest";
import { countStageKey, TAB_PARAM, tabFromParam } from "./types";

describe("pestaña desde la URL", () => {
  it("acepta solo los valores conocidos y cae en Existencias", () => {
    expect(tabFromParam("movimientos")).toBe("movements");
    expect(tabFromParam("conteos")).toBe("counts");
    expect(tabFromParam("existencias")).toBe("stock");
    expect(tabFromParam("movements")).toBe("stock");
    expect(tabFromParam(null)).toBe("stock");
    expect(tabFromParam(undefined)).toBe("stock");
  });
  it("cada pestaña tiene un valor de URL que vuelve a ella", () => {
    for (const [tab, param] of Object.entries(TAB_PARAM)) expect(tabFromParam(param)).toBe(tab);
  });
});

describe("etapa del conteo", () => {
  const draft = { status: "draft" as const, preliminaryAt: null, recountStartedAt: null };
  it("sigue las fases del borrador y marca los cerrados", () => {
    expect(countStageKey(draft)).toBe("countStageInitial");
    expect(countStageKey({ ...draft, preliminaryAt: "2026-11-01" })).toBe("countStagePreliminary");
    expect(countStageKey({ ...draft, preliminaryAt: "2026-11-01", recountStartedAt: "2026-11-02" })).toBe("countStageDefinitive");
    expect(countStageKey({ ...draft, status: "closed", recountStartedAt: "2026-11-02" })).toBe("countStatusClosed");
  });
});
