import { describe, expect, it, vi } from "vitest";
import type { ActiveContext } from "@/lib/activeRestaurant";
import {
  PLACED_BY_ROLES,
  displayNameFor,
  resolvePlacedBy,
  roleLabelKey,
  roundPlacedByData,
} from "./placedBy";

// staffAccess arrastra activeRestaurant (next/headers + NextAuth); acá sólo
// queremos su lista de roles.
vi.mock("@/lib/activeRestaurant", () => ({ getActiveContext: vi.fn() }));
import { STAFF_ROLES } from "@/lib/staffAccess";

function ctx(
  user: Partial<ActiveContext["session"]["user"]> & { role: ActiveContext["session"]["user"]["role"] },
  restaurantId: string | null,
  impersonating = false,
): ActiveContext {
  return {
    session: {
      user: { id: "u1", email: "juan.perez@resto.co", name: "Juan", ...user },
      expires: "2099-01-01",
    },
    restaurantId,
    impersonating,
    groupId: null,
  };
}

describe("resolvePlacedBy", () => {
  it("un mesero del comercio queda estampado con nombre y rol", () => {
    expect(resolvePlacedBy(ctx({ role: "mesero" }, "r1"), "r1")).toEqual({
      userId: "u1",
      name: "Juan",
      role: "mesero",
    });
  });

  it("sin sesión (pide el comensal) no hay quién montó", () => {
    expect(resolvePlacedBy(null, "r1")).toBeNull();
    expect(resolvePlacedBy(undefined, "r1")).toBeNull();
  });

  it("personal de OTRO comercio no cuenta", () => {
    expect(resolvePlacedBy(ctx({ role: "mesero" }, "r2"), "r1")).toBeNull();
  });

  it("un admin sin impersonar (sin restaurante activo) no cuenta", () => {
    expect(resolvePlacedBy(ctx({ role: "platform_admin" }, null), "r1")).toBeNull();
  });

  it("un platform_admin / group_admin impersonando el comercio sí cuenta como personal", () => {
    expect(
      resolvePlacedBy(ctx({ role: "platform_admin" }, "r1", true), "r1"),
    ).toMatchObject({ role: "platform_admin", name: "Juan" });
    expect(
      resolvePlacedBy(ctx({ role: "group_admin" }, "r1", true), "r1"),
    ).toMatchObject({ role: "group_admin" });
  });

  it("customer (legado) y roles comerciales nunca montan", () => {
    expect(resolvePlacedBy(ctx({ role: "customer" }, "r1"), "r1")).toBeNull();
    expect(resolvePlacedBy(ctx({ role: "comercial" }, "r1"), "r1")).toBeNull();
    expect(
      resolvePlacedBy(ctx({ role: "gerente_comercial" }, "r1"), "r1"),
    ).toBeNull();
  });

  it("todo el personal operativo puede montar (operator, cocina, bar, terminal…)", () => {
    for (const role of ["operator", "kitchen", "bar", "terminal", "mesero"] as const) {
      expect(resolvePlacedBy(ctx({ role }, "r1"), "r1")?.role).toBe(role);
    }
  });

  it("sin nombre cae a la parte local del correo", () => {
    expect(
      resolvePlacedBy(ctx({ role: "mesero", name: null }, "r1"), "r1")?.name,
    ).toBe("juan.perez");
    expect(
      resolvePlacedBy(ctx({ role: "mesero", name: "   " }, "r1"), "r1")?.name,
    ).toBe("juan.perez");
  });

  it("la lista de roles es la misma que STAFF_ROLES (no se desincronizan)", () => {
    expect([...PLACED_BY_ROLES].sort()).toEqual([...STAFF_ROLES].sort());
  });
});

describe("displayNameFor", () => {
  it("nunca devuelve vacío", () => {
    expect(displayNameFor({ name: null, email: null })).toBe("?");
    expect(displayNameFor({ name: "", email: "@x" })).toBe("?");
    expect(displayNameFor({ name: " Ana ", email: "a@b" })).toBe("Ana");
  });
});

describe("roundPlacedByData", () => {
  it("estampa las tres columnas o las deja en null explícito", () => {
    expect(roundPlacedByData({ userId: "u1", name: "Juan", role: "mesero" })).toEqual({
      placedByUserId: "u1",
      placedByName: "Juan",
      placedByRole: "mesero",
    });
    expect(roundPlacedByData(null)).toEqual({
      placedByUserId: null,
      placedByName: null,
      placedByRole: null,
    });
  });
});

describe("roleLabelKey", () => {
  it("mapea cada rol de personal a su clave del namespace kitchen", () => {
    expect(roleLabelKey("mesero")).toBe("roleMesero");
    expect(roleLabelKey("operator")).toBe("roleOperator");
    expect(roleLabelKey("kitchen")).toBe("roleKitchen");
    expect(roleLabelKey("bar")).toBe("roleBar");
    expect(roleLabelKey("terminal")).toBe("roleTerminal");
    expect(roleLabelKey("group_admin")).toBe("roleGroupAdmin");
    expect(roleLabelKey("platform_admin")).toBe("rolePlatformAdmin");
  });

  it("todo rol que monta tiene etiqueta", () => {
    for (const role of PLACED_BY_ROLES) expect(roleLabelKey(role)).not.toBeNull();
  });

  it("un rol desconocido o vacío no tiene clave", () => {
    expect(roleLabelKey("customer")).toBeNull();
    expect(roleLabelKey(null)).toBeNull();
    expect(roleLabelKey(undefined)).toBeNull();
  });
});
