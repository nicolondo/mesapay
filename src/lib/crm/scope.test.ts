import { describe, it, expect } from "vitest";
import { crmVisibleUserIds } from "./scope";

describe("crmVisibleUserIds", () => {
  const team = ["u2", "u3", "u4"];

  it("comercial sees only themselves", () => {
    expect(crmVisibleUserIds({ id: "u1", role: "comercial" }, team)).toEqual(["u1"]);
  });

  it("comercial with empty team still returns [id]", () => {
    expect(crmVisibleUserIds({ id: "u1", role: "comercial" }, [])).toEqual(["u1"]);
  });

  it("gerente_comercial sees themselves + team", () => {
    expect(crmVisibleUserIds({ id: "u1", role: "gerente_comercial" }, team)).toEqual([
      "u1",
      "u2",
      "u3",
      "u4",
    ]);
  });

  it("gerente_comercial with empty team sees only themselves", () => {
    expect(crmVisibleUserIds({ id: "u1", role: "gerente_comercial" }, [])).toEqual(["u1"]);
  });

  it("platform_admin returns null (no filter)", () => {
    expect(crmVisibleUserIds({ id: "admin1", role: "platform_admin" }, team)).toBeNull();
  });

  it("unknown role returns empty array", () => {
    expect(crmVisibleUserIds({ id: "u1", role: "operator" }, team)).toEqual([]);
  });

  it("another unknown role also returns empty array", () => {
    expect(crmVisibleUserIds({ id: "u1", role: "waiter" }, [])).toEqual([]);
  });
});
