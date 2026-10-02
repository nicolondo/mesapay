import { describe, expect, it } from "vitest";
import { canMoveBetweenTables } from "./tableMoveControl";

describe("table movement permissions", () => {
  it.each(["operator", "platform_admin", "group_admin"])("allows administrator %s in either policy", (role) => {
    expect(canMoveBetweenTables(role, true)).toBe(true);
    expect(canMoveBetweenTables(role, false)).toBe(true);
  });
  it("allows waiters only when the setting explicitly permits them", () => {
    expect(canMoveBetweenTables("mesero", false)).toBe(true);
    expect(canMoveBetweenTables("mesero", true)).toBe(false);
    expect(canMoveBetweenTables("mesero", undefined)).toBe(false);
    expect(canMoveBetweenTables("mesero", null)).toBe(false);
  });
  it.each(["kitchen", "bar", "terminal", "customer", "sales", "invented", null, undefined])("denies other roles %s even with the setting off", (role) => {
    expect(canMoveBetweenTables(role, false)).toBe(false);
    expect(canMoveBetweenTables(role, true)).toBe(false);
  });
});
