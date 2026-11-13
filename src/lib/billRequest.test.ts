import { describe, it, expect } from "vitest";
import {
  billAlertAppliesToPay,
  billRequestSourceForRole,
  shouldAnnounceBillOnPay,
} from "./billRequest";

describe("billRequestSourceForRole", () => {
  it("el comensal llega sin rol", () => {
    expect(billRequestSourceForRole(undefined)).toBe("diner");
    expect(billRequestSourceForRole(null)).toBe("diner");
  });

  it("mesero, operator y platform_admin son staff", () => {
    for (const role of ["mesero", "operator", "platform_admin"]) {
      expect(billRequestSourceForRole(role)).toBe("staff");
    }
  });

  it("el datáfono que inicia el cobro es staff: no es «la mesa pidió la cuenta»", () => {
    // Desde «Mesas en vivo» el datáfono cobra en la mesa (también con
    // "solo el administrador cobra"): no tiene que saltar el aviso de
    // pantalla completa al administrador.
    expect(billRequestSourceForRole("terminal")).toBe("staff");
    expect(
      shouldAnnounceBillOnPay({
        adminOnlyCharge: true,
        source: billRequestSourceForRole("terminal"),
        serviceMode: "table",
        tableNumber: 4,
      }),
    ).toBe(false);
  });
});

describe("billAlertAppliesToPay", () => {
  const base = {
    adminOnlyCharge: true,
    source: "diner" as const,
    serviceMode: "table",
  };

  it("avisa cuando el comensal elige forma de pago con la política activa", () => {
    expect(billAlertAppliesToPay(base)).toBe(true);
  });

  it("sin la política no avisa: el aviso ni siquiera está montado", () => {
    expect(billAlertAppliesToPay({ ...base, adminOnlyCharge: false })).toBe(
      false,
    );
  });

  it("no le avisa al administrador de su propio cobro", () => {
    expect(billAlertAppliesToPay({ ...base, source: "staff" })).toBe(false);
  });

  it("en mostrador no hay mesa a la que ir", () => {
    expect(billAlertAppliesToPay({ ...base, serviceMode: "counter" })).toBe(
      false,
    );
  });
});

describe("shouldAnnounceBillOnPay", () => {
  const base = {
    adminOnlyCharge: true,
    source: "diner" as const,
    serviceMode: "table",
  };

  it("mesa real ⇒ avisa", () => {
    expect(shouldAnnounceBillOnPay({ ...base, tableNumber: 7 })).toBe(true);
  });

  it("pseudo-mesa de pickup (número negativo) ⇒ no avisa", () => {
    expect(shouldAnnounceBillOnPay({ ...base, tableNumber: -1 })).toBe(false);
  });

  it("orden sin mesa ⇒ no avisa", () => {
    expect(shouldAnnounceBillOnPay({ ...base, tableNumber: null })).toBe(false);
  });

  it("arrastra el guard barato: sin política no avisa ni con mesa real", () => {
    expect(
      shouldAnnounceBillOnPay({
        ...base,
        adminOnlyCharge: false,
        tableNumber: 7,
      }),
    ).toBe(false);
  });
});
