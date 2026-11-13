import { afterEach, describe, expect, it, vi } from "vitest";
import * as format from "@/lib/format";
import { rangeLabel, weekdayDateLabel } from "./periodLabel";

afterEach(() => vi.restoreAllMocks());

describe("period labels across server and browser ICU versions", () => {
  it.each(["sáb, 31 de oct", "sáb, 31 de oct."])("keeps a stable Spanish day label for %s", value => {
    vi.spyOn(format, "formatDate").mockReturnValue(value);
    expect(weekdayDateLabel("2026-10-31", "es", "2026-11-08")).toBe("sáb, 31 de oct");
  });

  it.each(["sáb., 31 de out.", "sáb, 31 de out"])("keeps a stable Portuguese day label for %s", value => {
    vi.spyOn(format, "formatDate").mockReturnValue(value);
    expect(weekdayDateLabel("2026-10-31", "pt", "2026-11-08")).toBe("sáb, 31 de out");
  });

  it.each(["Sat, Oct 31", "Sat., Oct. 31"])("keeps a stable English day label for %s", value => {
    vi.spyOn(format, "formatDate").mockReturnValue(value);
    expect(weekdayDateLabel("2026-10-31", "en", "2026-11-08")).toBe("Sat, Oct 31");
  });

  it.each(["31 oct\u2009–\u20091 nov", "31 oct. – 1 nov."])("keeps a stable range label for %s", value => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatRange").mockReturnValue(value);
    expect(rangeLabel({ desde: "2026-10-31", hasta: "2026-11-01" }, "es", { year: false })).toBe("31 oct – 1 nov");
  });
});
