// "Resolver cobro" del datáfono Kushki: quién lo ve y desde cuándo. La ruta
// (/api/operator/payments/[id]/resolve-terminal) lo vuelve a exigir.
import { describe, expect, it } from "vitest";
import {
  TERMINAL_RESOLVE_AFTER_MS,
  canResolveTerminalCharge,
  manualTerminalRef,
  terminalResolvableAt,
} from "./terminalResolve";

describe("canResolveTerminalCharge", () => {
  it("sólo el administrador: operator, platform_admin y group_admin", () => {
    for (const role of ["operator", "platform_admin", "group_admin"]) expect(canResolveTerminalCharge(role), role).toBe(true);
  });

  it("NUNCA el mesero, ni la caja, la cocina, el comensal o nadie", () => {
    for (const role of ["mesero", "terminal", "kitchen", "bar", "diner", "comercial", "", null, undefined]) {
      expect(canResolveTerminalCharge(role), String(role)).toBe(false);
    }
  });
});

describe("terminalResolvableAt", () => {
  it("3 minutos después de enviarlo al datáfono (el Cloud Terminal corta a ~90 s)", () => {
    expect(TERMINAL_RESOLVE_AFTER_MS).toBe(180_000);
    expect(terminalResolvableAt("2026-10-31T18:30:00.000Z")).toBe(Date.parse("2026-10-31T18:33:00.000Z"));
    expect(terminalResolvableAt(new Date("2026-10-31T18:30:00.000Z"))).toBe(Date.parse("2026-10-31T18:33:00.000Z"));
  });

  it("sin envío (o una fecha rota) no hay desde cuándo: no se ofrece", () => {
    expect(terminalResolvableAt(null)).toBeNull();
    expect(terminalResolvableAt(undefined)).toBeNull();
    expect(terminalResolvableAt("no-es-fecha")).toBeNull();
  });
});

describe("manualTerminalRef", () => {
  it("nombra al actor y es única por pago (el ledger de Kushki la exige única)", () => {
    expect(manualTerminalRef("admin-1", "pay-1")).toBe("manual:admin-1:pay-1");
    expect(manualTerminalRef("admin-1", "pay-1")).not.toBe(manualTerminalRef("admin-1", "pay-2"));
  });
});
