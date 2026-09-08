import { describe, it, expect } from "vitest";
import type { Role } from "@prisma/client";
import { canStaffSignIn } from "./staffLogin";

/**
 * La restricción dura del cambio "registro del comensal por comercio": el
 * login del PERSONAL no se puede romper. Este test la fija.
 */
describe("canStaffSignIn", () => {
  const STAFF_ROLES: Role[] = [
    "operator",
    "mesero",
    "kitchen",
    "bar",
    "terminal",
    "platform_admin",
    "group_admin",
    "comercial",
    "gerente_comercial",
  ];

  it("deja entrar a todos los roles de personal", () => {
    for (const role of STAFF_ROLES) {
      expect(canStaffSignIn({ role, disabledAt: null })).toBe(true);
    }
  });

  it("bloquea al usuario desactivado, sea cual sea su rol", () => {
    for (const role of STAFF_ROLES) {
      expect(canStaffSignIn({ role, disabledAt: new Date() })).toBe(false);
    }
  });

  it("bloquea las filas legado con role=customer: User es solo personal", () => {
    expect(canStaffSignIn({ role: "customer", disabledAt: null })).toBe(false);
  });
});
