import { describe, expect, it, vi } from "vitest";
import {
  printOnTerminal,
  printTerminalStorageKey,
  terminalPrintBody,
  terminalPrintMessage,
} from "./terminalPrintClient";

const prebill = { kind: "prebill" as const, orderId: "order-1", href: "/terminal/precuenta/order-1" };
const route = (status: number, body: unknown) =>
  vi.fn(async () => ({ ok: status >= 200 && status < 300, json: async () => body }));

describe("pedirle al servidor que imprima en el datáfono", () => {
  it("manda el documento y el datáfono recordado", async () => {
    const fetch = route(200, { ok: true, state: "printed", printJobId: "j-1", deviceId: "A", deviceLabel: "Caja", simulated: false });
    const r = await printOnTerminal(prebill, { deviceId: "A", fetch });
    expect(fetch).toHaveBeenCalledWith("/api/operator/print/terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "prebill", orderId: "order-1", deviceId: "A" }),
    });
    expect(r).toEqual({ via: "terminal", state: "printed", printJobId: "j-1", deviceId: "A", deviceLabel: "Caja", simulated: false });
  });

  it("encolada sin imprimir: el reintento manda el mismo trabajo", async () => {
    const fetch = route(200, { ok: true, state: "queued", printJobId: "j-1", deviceId: "A", deviceLabel: "Caja", simulated: false });
    const r = await printOnTerminal(prebill, { deviceId: "A", printJobId: "j-1", fetch });
    expect(r).toMatchObject({ via: "terminal", state: "queued", printJobId: "j-1" });
    expect(fetch).toHaveBeenCalledWith("/api/operator/print/terminal", expect.objectContaining({
      body: JSON.stringify({ kind: "prebill", orderId: "order-1", deviceId: "A", printJobId: "j-1" }),
    }));
  });

  it("varios datáfonos: la lista para elegir", async () => {
    const r = await printOnTerminal(prebill, {
      fetch: route(409, { error: "choose_device", devices: [{ id: "A", label: "Caja" }, { id: "B", label: "Barra" }] }),
    });
    expect(r).toEqual({ via: "choose_device", devices: [{ id: "A", label: "Caja" }, { id: "B", label: "Barra" }] });
  });

  it("errores con su código; la red caída también", async () => {
    expect(await printOnTerminal(prebill, { fetch: route(502, { error: "print_failed", reason: "timeout" }) })).toEqual({
      via: "error",
      code: "print_failed",
      reason: "timeout",
    });
    expect(
      await printOnTerminal(prebill, {
        fetch: route(502, { error: "print_failed", reason: "OUT_OF_PAPER", errorCode: "OUT_OF_PAPER", printJobId: "j-2" }),
      }),
    ).toEqual({ via: "error", code: "print_failed", reason: "OUT_OF_PAPER", errorCode: "OUT_OF_PAPER", printJobId: "j-2" });
    expect(
      await printOnTerminal(prebill, {
        fetch: vi.fn(async () => {
          throw new Error("offline");
        }),
      }),
    ).toEqual({ via: "error", code: "network" });
  });

  it("el cuerpo del cierre lleva el turno", () => {
    expect(terminalPrintBody({ kind: "shift", shiftId: "s-1", href: "/x" })).toEqual({ kind: "shift", shiftId: "s-1" });
  });

  it("qué se le dice a quien imprime", () => {
    expect(terminalPrintMessage("no_devices")).toEqual({ key: "terminalNoDevices" });
    expect(terminalPrintMessage("cloud_business_code_missing")).toEqual({ key: "terminalBusinessCode" });
    expect(terminalPrintMessage("print_failed", "http_400")).toEqual({ key: "terminalKushkiFailed", values: { reason: "http_400" } });
    expect(terminalPrintMessage("order_closed")).toEqual({ key: "terminalClosed" });
    expect(terminalPrintMessage("network")).toEqual({ key: "terminalFailed" });
    // Lo que dijo el datáfono, traducido.
    expect(terminalPrintMessage("print_failed", "OUT_OF_PAPER", "OUT_OF_PAPER")).toEqual({ key: "terminalOutOfPaper" });
    expect(terminalPrintMessage("print_failed", "PRINTER_OVERHEAT", "PRINTER_OVERHEAT")).toEqual({
      key: "terminalJobFailed",
      values: { reason: "PRINTER_OVERHEAT" },
    });
  });

  it("«este datáfono es X» se recuerda por comercio", () => {
    expect(printTerminalStorageKey("rest-1")).toBe("mesapay.imprimir.datafono.rest-1");
    expect(printTerminalStorageKey(null)).toBe("mesapay.imprimir.datafono.general");
  });
});
