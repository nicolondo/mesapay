// El efectivo se graba como `cash`; lo histórico quedó como `demo_cash` y
// sigue siendo efectivo real. Todo lo que pregunta "¿esto es efectivo?"
// pasa por acá.
import { describe, expect, it } from "vitest";
import { PaymentMethod } from "@prisma/client";
import { CASH_METHOD, CASH_METHODS, isCashMethod, reportingPaymentMethod } from "./methods";

describe("isCashMethod", () => {
  it("cash y el histórico demo_cash son efectivo", () => {
    expect(isCashMethod("cash")).toBe(true);
    expect(isCashMethod("demo_cash")).toBe(true);
  });

  it("nada más lo es: tarjetas, datáfonos, bonos, crédito ni vacío", () => {
    for (const m of Object.values(PaymentMethod)) {
      if (m === "cash" || m === "demo_cash") continue;
      expect(isCashMethod(m), m).toBe(false);
    }
    expect(isCashMethod(null)).toBe(false);
    expect(isCashMethod(undefined)).toBe(false);
    expect(isCashMethod("")).toBe(false);
  });

  it("CASH_METHODS (para filtros de Prisma) coincide con el helper y existe en el enum", () => {
    expect([...CASH_METHODS].sort()).toEqual(["cash", "demo_cash"]);
    const enumValues: string[] = Object.values(PaymentMethod);
    for (const m of CASH_METHODS) {
      expect(isCashMethod(m)).toBe(true);
      expect(enumValues).toContain(m);
    }
  });

  it("un cobro nuevo en efectivo se graba como cash", () => {
    expect(CASH_METHOD).toBe("cash");
  });
});

describe("reportingPaymentMethod", () => {
  it("agrupa demo_cash con cash para no mostrar «Efectivo» dos veces", () => {
    expect(reportingPaymentMethod("demo_cash")).toBe("cash");
    expect(reportingPaymentMethod("cash")).toBe("cash");
  });

  it("el resto de los métodos pasa igual (demo_card sigue siendo demo)", () => {
    expect(reportingPaymentMethod("demo_card")).toBe("demo_card");
    expect(reportingPaymentMethod("kushki_card_terminal")).toBe("kushki_card_terminal");
    expect(reportingPaymentMethod("customer_credit")).toBe("customer_credit");
  });
});
