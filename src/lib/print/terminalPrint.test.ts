import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Este dispositivo» del usuario Datáfono: la impresión va al Smart POS por
 * el Print API cloud de Kushki. Se blinda: a qué datáfono va, que en mock
 * NO se llama a Kushki, que en producción el mock no imprime, y que un
 * rechazo de Kushki vuelve con su motivo. Nunca se llama a Kushki de verdad.
 */

const m = vi.hoisted(() => ({
  restaurant: vi.fn(),
  devices: vi.fn(),
  setup: vi.fn(),
  loadPrebill: vi.fn(),
  buildPrebill: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.restaurant },
    terminalDevice: { findMany: m.devices },
  },
}));
vi.mock("@/lib/payments/terminalAvailability", () => ({
  kushkiTerminalSetup: m.setup,
  terminalDeviceUsable: (d: { active: boolean; serialNumber: string | null }, real: boolean) =>
    d.active && (!real || !!d.serialNumber),
}));
vi.mock("./prebillData", () => ({ loadPrebill: m.loadPrebill }));
vi.mock("./prebillQueue", () => ({ buildPrebillDocument: m.buildPrebill }));
vi.mock("./invoiceQueue", () => ({ buildInvoiceDocument: vi.fn() }));
vi.mock("./shiftCloseQueue", () => ({ loadShiftCloseTicket: vi.fn() }));
vi.mock("@/lib/payments/kushki/cloudPrint", () => ({
  printOnCloudTerminal: () => {
    throw new Error("nunca se llama a Kushki en los tests");
  },
}));

import { chooseTerminalDevice, printOnTerminalDevice } from "./terminalPrint";

const dev = (id: string, over: Record<string, unknown> = {}) => ({
  kushkiDeviceId: id,
  label: `Datáfono ${id}`,
  serialNumber: `SN-${id}`,
  active: true,
  ...over,
});

const prebillDoc = {
  paperWidthMm: 58,
  businessName: "RESTAURANTE DE MUESTRA",
  businessLines: ["NIT 900000001"],
  title: "PRECUENTA",
  notInvoiceLine: "Este documento no es una factura",
  metaRows: [{ label: "Mesa", value: "3" }],
  items: [{ qty: 2, name: "Plato de muestra", amount: "$ 50.000", unit: "$ 25.000", modifiers: [], notes: null }],
  totals: [{ label: "TOTAL", amount: "$ 50.000", strong: true }],
  tipRows: [],
  tipNotice: null,
  footerLines: ["¡Gracias!"],
};

beforeEach(() => {
  vi.resetAllMocks();
  m.restaurant.mockResolvedValue({ id: "rest-1", kushkiMode: "mock", cloudTerminalBusinessCode: null });
  m.setup.mockResolvedValue({ mode: "mock", businessCode: null, useRealTerminal: false });
  m.devices.mockResolvedValue([dev("A")]);
  m.loadPrebill.mockResolvedValue({
    ok: true,
    data: { shortCode: "A4F2" },
    currency: "COP",
    locale: "es",
    paperWidthMm: 80,
  });
  m.buildPrebill.mockResolvedValue(prebillDoc);
});

describe("a qué datáfono va", () => {
  it("el que el equipo recuerda; si no, el único del comercio", () => {
    const a = dev("A");
    expect(chooseTerminalDevice([a, dev("B")], { deviceId: "B" })).toMatchObject({
      ok: true,
      device: { kushkiDeviceId: "B" },
    });
    expect(chooseTerminalDevice([a], {})).toEqual({ ok: true, device: a });
    // Un recuerdo que ya no existe no se adivina: con uno solo, ése.
    expect(chooseTerminalDevice([a], { deviceId: "Z" })).toEqual({ ok: true, device: a });
  });

  it("varios sin recuerdo: hay que elegir; ninguno: no hay datáfonos", () => {
    expect(chooseTerminalDevice([dev("A"), dev("B")], {})).toEqual({ ok: false, error: "choose_device" });
    expect(chooseTerminalDevice([dev("A"), dev("B")], { deviceId: "Z" })).toEqual({
      ok: false,
      error: "choose_device",
    });
    expect(chooseTerminalDevice([], {})).toEqual({ ok: false, error: "no_devices" });
  });
});

describe("imprimir en el datáfono", () => {
  const target = { kind: "prebill" as const, orderId: "order-1" };

  it("mock (sin Business-Code): simula el envío, sin llamar a Kushki", async () => {
    const send = vi.fn();
    const r = await printOnTerminalDevice(
      { restaurantId: "rest-1", userId: "user-1", target },
      { send, isProduction: false },
    );
    expect(send).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, deviceId: "A", deviceLabel: "Datáfono A", simulated: true, reference: "precuenta A4F2" });
  });

  it("en producción el mock no imprime", async () => {
    const r = await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target }, { isProduction: true });
    expect(r).toEqual({ ok: false, error: "mock_print_disabled" });
  });

  it("datáfono real: manda los comandos de la precuenta al serial, con su referencia", async () => {
    m.setup.mockResolvedValue({ mode: "production", businessCode: "BC-1", useRealTerminal: true });
    const send = vi.fn(async () => ({ ok: true, printJobId: "job-1", status: "PENDING" }));
    const r = await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target }, { send });
    expect(send).toHaveBeenCalledOnce();
    const call = (send.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(call).toMatchObject({ serialNumber: "SN-A", businessCode: "BC-1", mode: "production", externalReference: "prebill-order-1" });
    const texts = (call.commands as Array<{ type: string; text?: string }>).map((c) => c.text ?? c.type).join("|");
    expect(texts).toContain("PRECUENTA");
    expect(texts).toContain("cut");
    expect(r).toMatchObject({ ok: true, printJobId: "job-1", simulated: false });
  });

  it("datáfono real sin serial no cuenta; sin Business-Code no se puede firmar", async () => {
    m.setup.mockResolvedValue({ mode: "production", businessCode: "BC-1", useRealTerminal: true });
    m.devices.mockResolvedValue([dev("A", { serialNumber: null })]);
    expect(await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target }, { send: vi.fn() })).toEqual({
      ok: false,
      error: "no_devices",
    });
    m.setup.mockResolvedValue({ mode: "production", businessCode: null, useRealTerminal: true });
    expect(await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target })).toEqual({
      ok: false,
      error: "cloud_business_code_missing",
    });
  });

  it("Kushki rechaza: vuelve print_failed con el motivo", async () => {
    m.setup.mockResolvedValue({ mode: "production", businessCode: "BC-1", useRealTerminal: true });
    const send = vi.fn(async () => ({ ok: false, printJobId: "job-1", httpStatus: 400 }));
    expect(await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target }, { send })).toEqual({
      ok: false,
      error: "print_failed",
      reason: "http_400",
    });
  });

  it("varios datáfonos: devuelve la lista para elegir; una cuenta cerrada no imprime", async () => {
    m.devices.mockResolvedValue([dev("A"), dev("B")]);
    expect(await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target }, { isProduction: false })).toEqual({
      ok: false,
      error: "choose_device",
      devices: [
        { id: "A", label: "Datáfono A" },
        { id: "B", label: "Datáfono B" },
      ],
    });
    m.devices.mockResolvedValue([dev("A")]);
    m.loadPrebill.mockResolvedValue({ ok: false, reason: "order_closed" });
    expect(await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target }, { isProduction: false })).toEqual({
      ok: false,
      error: "order_closed",
    });
  });
});
