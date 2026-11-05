import { describe, expect, it } from "vitest";
import { DEFAULT_DINER_LIST_PARAMS, dinerListHref, parseCustomersView, parseDinerListParams } from "./dinerList";

describe("diner list params", () => {
  it("reads search, sort and page, defaulting to most spent", () => {
    expect(parseDinerListParams({ view: "diners", q: " ana ", sort: "recent", page: "2" })).toEqual({ q: "ana", sort: "recent", page: 2 });
    expect(parseDinerListParams({ sort: "debt" })).toEqual(DEFAULT_DINER_LIST_PARAMS);
  });
  it("builds the tab URL without defaults", () => {
    expect(dinerListHref(DEFAULT_DINER_LIST_PARAMS)).toBe("/operator/clientes?view=diners");
    expect(dinerListHref({ q: "77.889", sort: "name", page: 3 })).toBe("/operator/clientes?view=diners&q=77.889&sort=name&page=3");
  });
  it("only managers get the billing tab", () => {
    expect(parseCustomersView({}, true)).toBe("billing");
    expect(parseCustomersView({ view: "diners" }, true)).toBe("diners");
    expect(parseCustomersView({}, false)).toBe("diners");
    expect(parseCustomersView({ view: "billing" }, false)).toBe("diners");
  });
});
