import { describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { meseroTableWhere, type MeseroScope } from "./meseroScope";

/**
 * Las facturas manuales (mesas `kind = manual`) no son del salón: el
 * filtro de mesas de un mesero las excluye SIEMPRE, con o sin sección
 * asignada. Para los demás roles el filtro sigue sin existir.
 */
describe("meseroTableWhere", () => {
  it("sin scope (operador, admin, cocina) no filtra nada", () => {
    const scope: MeseroScope = { scoped: false, tableNumbers: null, hideManual: false };
    expect(meseroTableWhere(scope)).toBeUndefined();
  });

  it("un mesero sin sección asignada igual deja afuera las facturas manuales", () => {
    const scope: MeseroScope = { scoped: false, tableNumbers: null, hideManual: true };
    expect(meseroTableWhere(scope)).toEqual({ kind: { not: "manual" } });
  });

  it("un mesero con sección ve sus mesas y ninguna factura manual", () => {
    const scope: MeseroScope = { scoped: true, tableNumbers: [1, 3, 5], hideManual: true };
    expect(meseroTableWhere(scope)).toEqual({
      number: { in: [1, 3, 5] },
      kind: { not: "manual" },
    });
  });
});
