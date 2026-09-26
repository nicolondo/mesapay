// El efectivo se graba como `cash`; lo histórico quedó como `demo_cash` y
// sigue siendo efectivo real. Todo lo que pregunta "¿esto es efectivo?"
// pasa por acá.
import { describe, expect, it } from "vitest";
import { PaymentMethod } from "@prisma/client";
import {
  CASH_METHOD,
  CASH_METHODS,
  REPLACEABLE_PENDING_METHODS,
  isCashMethod,
  isReplaceablePendingMethod,
  reportingPaymentMethod,
} from "./methods";

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

// Qué pendientes son sólo una SOLICITUD del comensal (sin plata en vuelo en
// un proveedor) y el staff reemplaza al cobrar. Ver el `Record` en methods.ts
// con el porqué de cada método.
describe("isReplaceablePendingMethod / REPLACEABLE_PENDING_METHODS", () => {
  it("efectivo (también el histórico) y el datáfono propio del comercio son solicitudes", () => {
    expect([...REPLACEABLE_PENDING_METHODS].sort()).toEqual(["cash", "demo_cash", "external_terminal"]);
    for (const m of REPLACEABLE_PENDING_METHODS) expect(isReplaceablePendingMethod(m), m).toBe(true);
  });

  it("los pagos con proveedor externo en curso NUNCA se reemplazan", () => {
    for (const m of [
      "kushki_card_terminal",
      "kushki_card",
      "kushki_apple_pay",
      "kushki_google_pay",
      "kushki_pse",
      "wompi_card",
      "wompi_pse",
      "wompi_nequi",
    ]) {
      expect(isReplaceablePendingMethod(m), m).toBe(false);
    }
  });

  it("lo que nace aprobado (abono, bono, crédito, tarjeta demo) tampoco", () => {
    for (const m of ["reservation_deposit", "voucher", "customer_credit", "demo_card"]) {
      expect(isReplaceablePendingMethod(m), m).toBe(false);
    }
  });

  it("cubre el enum entero: todo método del schema está clasificado y existe", () => {
    const enumValues: string[] = Object.values(PaymentMethod);
    for (const m of REPLACEABLE_PENDING_METHODS) expect(enumValues).toContain(m);
    // Cada valor del enum responde algo definido (el Record obliga a
    // clasificar los nuevos en compilación; esto lo confirma en runtime).
    for (const m of enumValues) expect(typeof isReplaceablePendingMethod(m)).toBe("boolean");
  });

  it("lo desconocido o vacío se respeta (no se reemplaza)", () => {
    for (const m of [null, undefined, "", "toString", "__proto__", "bitcoin"]) {
      expect(isReplaceablePendingMethod(m), String(m)).toBe(false);
    }
  });
});

