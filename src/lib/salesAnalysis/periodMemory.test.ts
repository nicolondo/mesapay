import { describe, expect, it } from "vitest";
import { parseSalesFilters, SALES_ANALYSIS_PATH } from "./filters";
import { restoredPeriodHref, serializePeriod } from "./periodMemory";

const now = Date.UTC(2026, 10, 15);
const save = (query: string) => serializePeriod(parseSalesFilters(new URLSearchParams(query)), now);
const day = 86_400_000;

describe("sales period memory", () => {
  it("restores relative presets without dates or unrelated filters", () => {
    const saved = save("periodo=semana&tiempo=pago&mesero=abc&comparar=no");
    expect(restoredPeriodHref("", saved, now + 30 * day)).toBe(`${SALES_ANALYSIS_PATH}?periodo=semana&tiempo=pago`);
  });

  it("restores both custom dates", () => {
    const query = "periodo=rango&desde=2026-10-01&hasta=2026-10-31";
    expect(restoredPeriodHref("", save(query), now)).toBe(`${SALES_ANALYSIS_PATH}?${query}`);
  });

  it("leaves any explicit URL and the default selection alone", () => {
    expect(restoredPeriodHref("comparar=no", save("periodo=mes"), now)).toBeNull();
    expect(restoredPeriodHref("", save("periodo=30d"), now)).toBeNull();
  });

  it("ignores expired, future and malformed records", () => {
    expect(restoredPeriodHref("", save("periodo=mes"), now + 30 * day + 1)).toBeNull();
    expect(restoredPeriodHref("", save("periodo=mes"), now - 1)).toBeNull();
    for (const saved of [null, "{", "null", "{}", save("periodo=mes").replace("mes", "rango:2026-02-30:2026-03-01"), save("periodo=mes").replace("pedido", "invalid")]) {
      expect(restoredPeriodHref("", saved, now)).toBeNull();
    }
  });
});
