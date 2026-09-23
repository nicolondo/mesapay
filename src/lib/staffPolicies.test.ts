import { describe, it, expect } from "vitest";
import {
  COMP_NOT_ALLOWED_ERROR,
  COMP_ROLES,
  DEFAULT_COMP_ALLOWED_ROLES,
  canCompOrders,
  isCompRole,
  resolveCompAllowedRoles,
} from "./staffPolicies";

describe("COMP_ROLES", () => {
  it("son los roles que operan mesas; cocina y bar no cobran", () => {
    expect([...COMP_ROLES]).toEqual(["operator", "mesero", "terminal"]);
    expect(isCompRole("kitchen")).toBe(false);
    expect(isCompRole("bar")).toBe(false);
    expect(isCompRole("platform_admin")).toBe(false);
    expect(isCompRole(null)).toBe(false);
  });

  it("el default es sólo el administrador (lo que pidió el dueño)", () => {
    expect([...DEFAULT_COMP_ALLOWED_ROLES]).toEqual(["operator"]);
  });
});

describe("resolveCompAllowedRoles", () => {
  it("null/undefined caen al default (fila vieja o rollback)", () => {
    expect(resolveCompAllowedRoles(null)).toEqual(["operator"]);
    expect(resolveCompAllowedRoles(undefined)).toEqual(["operator"]);
  });

  it("la lista vacía es una decisión válida: nadie del equipo", () => {
    expect(resolveCompAllowedRoles([])).toEqual([]);
  });

  it("filtra basura, deduplica y devuelve el orden canónico", () => {
    expect(
      resolveCompAllowedRoles([
        "mesero",
        "kitchen",
        "operator",
        "mesero",
        "lo_que_sea",
        "terminal",
      ]),
    ).toEqual(["operator", "mesero", "terminal"]);
  });
});

describe("canCompOrders", () => {
  it("con la política por defecto sólo el administrador puede", () => {
    for (const policy of [undefined, null]) {
      expect(canCompOrders("operator", policy)).toBe(true);
      expect(canCompOrders("mesero", policy)).toBe(false);
      expect(canCompOrders("terminal", policy)).toBe(false);
    }
  });

  it("respeta la lista del comercio", () => {
    const policy = ["operator", "mesero"];
    expect(canCompOrders("operator", policy)).toBe(true);
    expect(canCompOrders("mesero", policy)).toBe(true);
    expect(canCompOrders("terminal", policy)).toBe(false);
    expect(canCompOrders("terminal", ["terminal"])).toBe(true);
    expect(canCompOrders("operator", ["mesero"])).toBe(false);
  });

  it("con la lista vacía nadie del equipo puede", () => {
    for (const role of COMP_ROLES) {
      expect(canCompOrders(role, [])).toBe(false);
    }
  });

  it("platform_admin y group_admin (impersonando) pueden siempre", () => {
    for (const policy of [[], ["mesero"], undefined]) {
      expect(canCompOrders("platform_admin", policy)).toBe(true);
      expect(canCompOrders("group_admin", policy)).toBe(true);
    }
  });

  it("cocina, bar, el comensal (sin rol) y roles desconocidos nunca", () => {
    // Aunque alguien meta "kitchen" en la lista a mano, no cuenta.
    const policy = ["operator", "mesero", "terminal", "kitchen", "bar"];
    expect(canCompOrders("kitchen", policy)).toBe(false);
    expect(canCompOrders("bar", policy)).toBe(false);
    expect(canCompOrders("customer", policy)).toBe(false);
    expect(canCompOrders("comercial", policy)).toBe(false);
    expect(canCompOrders(undefined, policy)).toBe(false);
    expect(canCompOrders(null, policy)).toBe(false);
    expect(canCompOrders("", policy)).toBe(false);
  });
});

describe("COMP_NOT_ALLOWED_ERROR", () => {
  it("es estable: el cliente lo usa como clave de traducción (apiErrors)", () => {
    expect(COMP_NOT_ALLOWED_ERROR).toBe("comp_not_allowed");
  });
});
