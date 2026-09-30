import { expect, it } from "vitest";
import { formatMoney } from "./format";

it("can show the exact value being removed from inventory, including cents", () => {
  expect(formatMoney(120050, { currency: "COP", locale: "es", fractionDigits: 2 }).replace(/\s/g, "")).toBe("$1.200,50");
  expect(formatMoney(1, { currency: "COP", locale: "es", fractionDigits: 2 }).replace(/\s/g, "")).toBe("$0,01");
  expect(formatMoney(-1, { currency: "COP", locale: "es", fractionDigits: 2 }).replace(/\s/g, "")).toBe("-$0,01");
});

it("keeps existing currency rounding when precision is not specified", () => {
  expect(formatMoney(120050, { currency: "COP", locale: "es" }).replace(/\s/g, "")).toBe("$1.201");
  expect(formatMoney(120050, { currency: "USD", locale: "en" }).replace(/\s/g, "")).toBe("$1,200.50");
});
