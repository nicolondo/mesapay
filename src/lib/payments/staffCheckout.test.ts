import { describe, expect, it } from "vitest";

import {
  CHECKOUT_STAFF_ROLES,
  collectorUserIdFor,
  staffCheckoutCapabilities,
  staffCheckoutRoutes,
  staffCheckoutView,
} from "./staffCheckout";

const ids = { slug: "casa", orderId: "o1" };

describe("CHECKOUT_STAFF_ROLES", () => {
  it("incluye al datáfono junto al mesero y los administradores; nunca cocina ni bar", () => {
    expect([...CHECKOUT_STAFF_ROLES]).toEqual([
      "operator",
      "platform_admin",
      "group_admin",
      "mesero",
      "terminal",
    ]);
    expect(CHECKOUT_STAFF_ROLES).not.toContain("kitchen");
    expect(CHECKOUT_STAFF_ROLES).not.toContain("bar");
  });
});

describe("staffCheckoutRoutes", () => {
  it("el datáfono vuelve a «Mesas en vivo» y reintenta en su propio checkout", () => {
    expect(staffCheckoutRoutes("terminal", ids)).toEqual({
      checkoutHref: "/terminal/cobrar/o1",
      doneHref: "/t/casa/pay/o1/done?op=1",
      homeHref: "/terminal",
      serveHref: "/terminal",
    });
  });

  it("el mesero se queda dentro de su app", () => {
    expect(staffCheckoutRoutes("mesero", ids)).toEqual({
      checkoutHref: "/mesero/cobrar/o1",
      doneHref: "/mesero/cobrar/o1/done",
      homeHref: "/mesero/mesas",
      serveHref: "/mesero/salon",
    });
  });

  it.each(["operator", "platform_admin", "group_admin", null, undefined])(
    "%s usa las pantallas del panel",
    (role) => {
      expect(staffCheckoutRoutes(role, ids)).toEqual({
        checkoutHref: "/t/casa/pay/o1?op=1",
        doneHref: "/t/casa/pay/o1/done?op=1",
        homeHref: "/operator/tables",
        serveHref: "/operator/serve",
      });
    },
  );
});

describe("staffCheckoutCapabilities", () => {
  it("el datáfono sólo cobra: sin anular, cliente, crédito, bonos, factura previa ni impresoras (sí Bre-B: cobra en la mesa)", () => {
    expect(staffCheckoutCapabilities("terminal")).toEqual({
      annulInvoice: false,
      customerStep: false,
      credit: false,
      vouchers: false,
      preInvoice: false,
      configurePrinters: false,
      breB: true,
    });
  });

  it("el mesero conserva lo de siempre, menos anular facturas y configurar impresoras", () => {
    expect(staffCheckoutCapabilities("mesero")).toEqual({
      annulInvoice: false,
      customerStep: true,
      credit: true,
      vouchers: true,
      preInvoice: true,
      configurePrinters: false,
      breB: true,
    });
  });

  it("el administrador lo tiene todo", () => {
    for (const role of ["operator", "platform_admin", "group_admin"]) {
      expect(Object.values(staffCheckoutCapabilities(role)).every(Boolean)).toBe(true);
    }
  });

  it("vista por rol", () => {
    expect(staffCheckoutView("terminal")).toBe("terminal");
    expect(staffCheckoutView("mesero")).toBe("mesero");
    expect(staffCheckoutView("operator")).toBe("admin");
  });
});

describe("collectorUserIdFor", () => {
  it("anota al usuario de datáfono que inicia el cobro (auditoría)", () => {
    expect(collectorUserIdFor({ id: "pos-1", role: "terminal" })).toBe("pos-1");
  });

  it("como siempre: mesero, administrador y soporte quedan anotados", () => {
    for (const role of ["mesero", "operator", "platform_admin"]) {
      expect(collectorUserIdFor({ id: "u1", role })).toBe("u1");
    }
  });

  it("el comensal, cocina, bar o sin sesión: nadie", () => {
    expect(collectorUserIdFor(null)).toBeNull();
    expect(collectorUserIdFor(undefined)).toBeNull();
    expect(collectorUserIdFor({ id: "d1", role: null })).toBeNull();
    for (const role of ["customer", "kitchen", "bar"]) {
      expect(collectorUserIdFor({ id: "u1", role })).toBeNull();
    }
  });
});
