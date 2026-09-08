import { describe, it, expect } from "vitest";
import {
  CHARGE_ADMIN_ONLY_ERROR,
  canRoleStartCharge,
  effectiveShiftPolicy,
  isAdminRole,
  isChargeBlockedForRole,
  shiftPolicyAllowedWith,
} from "./chargeControl";

describe("canRoleStartCharge", () => {
  it("con la política apagada no cambia nada para nadie", () => {
    for (const role of [
      "mesero",
      "operator",
      "platform_admin",
      "terminal",
      undefined,
    ]) {
      expect(canRoleStartCharge(role, false)).toBe(true);
    }
  });

  it("con la política encendida bloquea SOLO al mesero", () => {
    expect(canRoleStartCharge("mesero", true)).toBe(false);
    expect(canRoleStartCharge("operator", true)).toBe(true);
    expect(canRoleStartCharge("platform_admin", true)).toBe(true);
  });

  it("no bloquea al datáfono: el rol terminal ES la caja, no un mesero", () => {
    expect(canRoleStartCharge("terminal", true)).toBe(true);
  });

  it("no bloquea al comensal, que llega sin sesión", () => {
    // El comensal pagando desde su QR no tiene rol. La política restringe
    // al staff, no al cliente.
    expect(canRoleStartCharge(undefined, true)).toBe(true);
    expect(canRoleStartCharge(null, true)).toBe(true);
  });

  it("isChargeBlockedForRole es el inverso exacto", () => {
    for (const role of ["mesero", "operator", undefined]) {
      for (const on of [true, false]) {
        expect(isChargeBlockedForRole(role, on)).toBe(
          !canRoleStartCharge(role, on),
        );
      }
    }
  });
});

describe("isAdminRole", () => {
  it("reconoce a los dueños del cobro", () => {
    expect(isAdminRole("operator")).toBe(true);
    expect(isAdminRole("platform_admin")).toBe(true);
  });
  it("descarta al resto", () => {
    expect(isAdminRole("mesero")).toBe(false);
    expect(isAdminRole("terminal")).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });
});

describe("effectiveShiftPolicy", () => {
  it("respeta la política guardada cuando el control de caja está apagado", () => {
    expect(effectiveShiftPolicy("by_waiter", false)).toBe("by_waiter");
    expect(effectiveShiftPolicy("global", false)).toBe("global");
  });

  it("fuerza turno único del local cuando el control de caja está activo", () => {
    expect(effectiveShiftPolicy("by_waiter", true)).toBe("global");
    expect(effectiveShiftPolicy("global", true)).toBe("global");
  });

  it("cae al default ante un valor desconocido (back-compat de rollback)", () => {
    expect(effectiveShiftPolicy("lo_que_sea", false)).toBe("global");
    expect(effectiveShiftPolicy(null, false)).toBe("global");
    expect(effectiveShiftPolicy(undefined, false)).toBe("global");
  });
});

describe("shiftPolicyAllowedWith", () => {
  it("rechaza la única combinación contradictoria", () => {
    expect(shiftPolicyAllowedWith("by_waiter", true)).toBe(false);
  });

  it("acepta el resto", () => {
    expect(shiftPolicyAllowedWith("global", true)).toBe(true);
    expect(shiftPolicyAllowedWith("by_waiter", false)).toBe(true);
    expect(shiftPolicyAllowedWith("global", false)).toBe(true);
  });
});

describe("CHARGE_ADMIN_ONLY_ERROR", () => {
  it("es estable: el cliente lo usa como clave de traducción", () => {
    expect(CHARGE_ADMIN_ONLY_ERROR).toBe("charge_admin_only");
  });
});
