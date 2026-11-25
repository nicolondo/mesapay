import { describe, expect, it } from "vitest";

import { activeSectionKey, parseCollapsed } from "./activeSectionMemory";

/**
 * El plegado de «Activas» se recuerda por aparato y comercio. Acá van las
 * dos piezas que no dependen del navegador: con qué clave se guarda y qué
 * cuenta como «plegada».
 */

describe("activeSectionKey", () => {
  it("una clave por comercio: dos restaurantes no se pisan", () => {
    expect(activeSectionKey("casa-teresita")).toBe(
      "mesapay.activeSection.casa-teresita",
    );
    expect(activeSectionKey("casa-teresita")).not.toBe(
      activeSectionKey("otro-local"),
    );
  });

  it("sin comercio, una clave aparte y no una a medias", () => {
    expect(activeSectionKey("")).toBe("mesapay.activeSection.anon");
  });
});

describe("parseCollapsed", () => {
  it("sólo lo guardado por nosotros pliega", () => {
    expect(parseCollapsed("collapsed")).toBe(true);
  });

  it("por defecto, desplegada: nada guardado o un valor viejo/raro", () => {
    expect(parseCollapsed(null)).toBe(false);
    expect(parseCollapsed("")).toBe(false);
    expect(parseCollapsed("true")).toBe(false);
    expect(parseCollapsed("expanded")).toBe(false);
  });
});
