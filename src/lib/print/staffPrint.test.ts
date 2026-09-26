import { describe, expect, it, vi } from "vitest";
import type { BrowserPrintOutcome } from "@/lib/printInBrowser";
import {
  agentMessage,
  browserPrintUrl,
  invoicePrintHref,
  printAsStaff,
  staffPrintAccessFor,
  staffPrintEndpoint,
  type StaffPrintDoc,
} from "./staffPrint";

/**
 * Los botones "Imprimir" del STAFF (factura, comprobante, precuenta):
 * primero el AGENTE, como las comandas; el navegador SÓLO si no hay
 * impresora de facturas o su agente no responde. Lo que se blinda:
 *
 *   · con impresora, se encola y NO se abre el diálogo del navegador;
 *   · sin impresora (o agente caído), se imprime la vista HTML en el
 *     iframe oculto, con la pestaña `?print=1` de respaldo;
 *   · un error de la ruta (cuenta cerrada, sin sesión de staff) NO
 *     imprime nada a ciegas.
 */

const invoice: StaffPrintDoc = {
  kind: "invoice",
  orderId: "order-1",
  href: invoicePrintHref({ invoiceId: "inv-1" }),
};
const prebill: StaffPrintDoc = {
  kind: "prebill",
  orderId: "order-1",
  href: "/mesero/precuenta/order-1",
};

function route(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, json: async () => body }));
}

function browser(outcome: BrowserPrintOutcome = { kind: "printed" }) {
  return vi.fn(async () => outcome);
}

describe("a qué ruta y a qué vista", () => {
  it("la vista de la factura es una RUTA de este origen, aunque llegue la URL pública", () => {
    expect(invoicePrintHref({ invoiceId: "inv-1" })).toBe("/factura/inv-1");
    expect(invoicePrintHref({ invoiceUrl: "https://mesapay.co/factura/inv-9" })).toBe(
      "/factura/inv-9",
    );
    expect(invoicePrintHref({ invoiceUrl: "https://mesapay.co/factura/inv-9?print=1" })).toBe(
      "/factura/inv-9",
    );
  });

  it("la factura va por reprint-invoice y su respaldo es /factura/[id]", () => {
    expect(staffPrintEndpoint(invoice)).toBe("/api/operator/orders/order-1/reprint-invoice");
    expect(browserPrintUrl(invoice)).toBe("/factura/inv-1");
  });

  it("la precuenta va por prebill y su respaldo es la vista de quien la pide", () => {
    expect(staffPrintEndpoint(prebill)).toBe("/api/operator/orders/order-1/prebill");
    expect(browserPrintUrl(prebill)).toBe("/mesero/precuenta/order-1");
  });
});

describe("con impresora de facturas: sale por el agente", () => {
  it("factura ⇒ encola y dice por cuál impresora, sin tocar el navegador", async () => {
    const fetch = route(200, {
      queued: true,
      printers: 1,
      printerName: "Caja",
      document: "factura_electronica",
    });
    const printInBrowser = browser();
    const r = await printAsStaff(invoice, { fetch, printInBrowser });
    expect(fetch).toHaveBeenCalledWith("/api/operator/orders/order-1/reprint-invoice", {
      method: "POST",
    });
    expect(r).toEqual({ via: "agent", printerName: "Caja", document: "factura_electronica" });
    expect(printInBrowser).not.toHaveBeenCalled();
  });

  it("factura con la DIAN pendiente ⇒ lo avisa (salió el comprobante)", async () => {
    const r = await printAsStaff(invoice, {
      fetch: route(200, {
        queued: true,
        printerName: "Caja",
        document: "comprobante",
        dianPending: true,
      }),
      printInBrowser: browser(),
    });
    expect(r).toEqual({
      via: "agent",
      printerName: "Caja",
      document: "comprobante",
      dianPending: true,
    });
  });

  it("precuenta ⇒ encola por prebill y dice la impresora", async () => {
    const fetch = route(200, { queued: true, printerName: "Caja", jobs: 1 });
    const printInBrowser = browser();
    const r = await printAsStaff(prebill, { fetch, printInBrowser });
    expect(fetch).toHaveBeenCalledWith("/api/operator/orders/order-1/prebill", { method: "POST" });
    expect(r).toEqual({ via: "agent", printerName: "Caja" });
    expect(printInBrowser).not.toHaveBeenCalled();
  });
});

describe("sin impresora (o agente caído): el navegador, como respaldo", () => {
  it.each(["no_printer", "agent_offline"] as const)(
    "factura con %s ⇒ imprime /factura/[id] en el iframe oculto, con la pestaña ?print=1 de respaldo",
    async (reason) => {
      const printInBrowser = browser();
      const onBrowserFallback = vi.fn();
      const r = await printAsStaff(invoice, {
        fetch: route(200, { queued: false, reason }),
        printInBrowser,
        onBrowserFallback,
      });
      // Avisa ANTES de imprimir, para mostrar "preparando…" mientras carga.
      expect(onBrowserFallback).toHaveBeenCalledWith(reason);
      expect(onBrowserFallback.mock.invocationCallOrder[0]).toBeLessThan(
        printInBrowser.mock.invocationCallOrder[0],
      );
      expect(printInBrowser).toHaveBeenCalledWith("/factura/inv-1", {
        tabUrl: "/factura/inv-1?print=1",
      });
      expect(r).toEqual({
        via: "browser",
        reason,
        outcome: { kind: "printed" },
        tabUrl: "/factura/inv-1?print=1",
      });
    },
  );

  it("precuenta sin impresora ⇒ su vista, y en la PWA del mesero la pestaña navega in-app", async () => {
    const printInBrowser = browser({ kind: "tab", blocked: false });
    const openTab = vi.fn(() => true);
    const r = await printAsStaff(prebill, {
      fetch: route(200, { queued: false, reason: "no_printer" }),
      printInBrowser,
      openTab,
    });
    expect(printInBrowser).toHaveBeenCalledWith("/mesero/precuenta/order-1", {
      tabUrl: "/mesero/precuenta/order-1?print=1",
      openTab,
    });
    expect(r).toMatchObject({ via: "browser", reason: "no_printer" });
  });
});

describe("errores: no se imprime nada a ciegas", () => {
  it("sin sesión de staff (el comensal) ⇒ error, sin navegador", async () => {
    const printInBrowser = browser();
    const r = await printAsStaff(invoice, {
      fetch: route(401, { error: "unauthorized" }),
      printInBrowser,
    });
    expect(r).toEqual({ via: "error", code: "unauthorized" });
    expect(printInBrowser).not.toHaveBeenCalled();
  });

  it("cuenta ya cerrada (precuenta) ⇒ error con su código", async () => {
    const r = await printAsStaff(prebill, {
      fetch: route(409, { error: "order_closed" }),
      printInBrowser: browser(),
    });
    expect(r).toEqual({ via: "error", code: "order_closed" });
  });

  it("un motivo desconocido o la red caída ⇒ error", async () => {
    expect(
      await printAsStaff(invoice, {
        fetch: route(200, { queued: false, reason: "otra_cosa" }),
        printInBrowser: browser(),
      }),
    ).toEqual({ via: "error", code: "otra_cosa" });
    expect(
      await printAsStaff(invoice, {
        fetch: vi.fn(async () => {
          throw new Error("offline");
        }),
        printInBrowser: browser(),
      }),
    ).toEqual({ via: "error", code: null });
  });
});

describe("agentMessage — qué se le dice al que apretó el botón", () => {
  it("\"Enviada a Caja\", o la factura electrónica", () => {
    expect(agentMessage({ via: "agent", printerName: "Caja" })).toEqual({
      tone: "ok",
      key: "sentTo",
      values: { printer: "Caja" },
    });
    expect(
      agentMessage({ via: "agent", printerName: "Caja", document: "factura_electronica" }),
    ).toEqual({ tone: "ok", key: "sentToEinvoice", values: { printer: "Caja" } });
  });

  it("sin nombre de impresora, el genérico", () => {
    expect(agentMessage({ via: "agent", printerName: "" })).toEqual({ tone: "ok", key: "sent" });
  });

  it("la DIAN pendiente es un aviso (no se va solo)", () => {
    expect(
      agentMessage({ via: "agent", printerName: "Caja", document: "comprobante", dianPending: true }),
    ).toEqual({ tone: "warn", key: "sentDianPending", values: { printer: "Caja" } });
  });
});

describe("staffPrintAccessFor — quién ve el botón del agente", () => {
  it("operador, admins y mesero sí; sólo los que entran a Configuración ven el link", () => {
    for (const role of ["operator", "platform_admin", "group_admin"]) {
      expect(staffPrintAccessFor(role)).toEqual({ canConfigurePrinters: true });
    }
    expect(staffPrintAccessFor("mesero")).toEqual({ canConfigurePrinters: false });
  });

  it("el comensal (sin sesión o con rol de comensal) y la cocina, no: nunca encolan", () => {
    for (const role of [null, undefined, "", "diner", "kitchen", "bar", "terminal"]) {
      expect(staffPrintAccessFor(role)).toBeNull();
    }
  });
});
