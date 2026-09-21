import { describe, expect, it } from "vitest";
import {
  isMoneyAccountCode,
  legacyPurchasePaymentAccount,
  resolvePurchasePaymentAccount,
} from "./paymentAccounts";

describe("isMoneyAccountCode", () => {
  it("acepta caja/bancos/pasarela (prefijo 11)", () => {
    expect(isMoneyAccountCode("110505")).toBe(true);
    expect(isMoneyAccountCode("111005")).toBe(true);
    expect(isMoneyAccountCode("112005")).toBe(true);
  });
  it("rechaza cuentas que no son de dinero", () => {
    expect(isMoneyAccountCode("220505")).toBe(false);
    expect(isMoneyAccountCode("143505")).toBe(false);
  });
});

describe("legacyPurchasePaymentAccount (abonos viejos sin cuenta)", () => {
  it.each([
    [null, "110505"],
    [undefined, "110505"],
    ["", "110505"],
    ["Efectivo", "110505"],
    ["Transferencia Bancolombia", "111005"],
    ["Nequi", "111005"],
    ["tarjeta débito", "111005"],
    ["consignación", "111005"],
    ["PSE", "111005"],
    ["Bre-B", "111005"],
  ])("%s → %s", (method, expected) => {
    expect(legacyPurchasePaymentAccount(method)).toBe(expected);
  });
});

describe("resolvePurchasePaymentAccount", () => {
  it("prefiere la cuenta elegida cuando existe", () => {
    expect(
      resolvePurchasePaymentAccount({ accountCode: "112005", method: "Efectivo" }),
    ).toBe("112005");
  });
  it("cae en la heurística sólo cuando no hay cuenta", () => {
    expect(
      resolvePurchasePaymentAccount({ accountCode: null, method: "Nequi" }),
    ).toBe("111005");
    expect(resolvePurchasePaymentAccount({ accountCode: null, method: null })).toBe(
      "110505",
    );
  });
});
