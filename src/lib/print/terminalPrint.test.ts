import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Este dispositivo» del usuario Datáfono: la impresión va al Smart POS por
 * el Print API cloud de Kushki. Se blinda: a qué datáfono va, que en mock
 * NO se llama a Kushki, que en producción el mock no imprime, y que un
 * rechazo de Kushki vuelve con su motivo. Nunca se llama a Kushki de verdad.
 */

const m = vi.hoisted(() => ({
  audit: vi.fn(),
  restaurant: vi.fn(),
  devices: vi.fn(),
  setup: vi.fn(),
  loadPrebill: vi.fn(),
  buildPrebill: vi.fn(),
  invoiceRow: vi.fn(),
  buildInvoice: vi.fn(),
  loadPayments: vi.fn(),
}));
vi.mock("@/lib/payments/terminalPrinterLock", () => ({
  refreshPreviousPrint: vi.fn(), reservePrint: vi.fn(), releasePrint: vi.fn(), recordPrintFault: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    auditEvent: { create: m.audit },
    restaurant: { findUnique: m.restaurant },
    terminalDevice: { findMany: m.devices },
    simpleInvoice: { findUnique: m.invoiceRow },
  },
}));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: async () => "COP" }));
vi.mock("@/lib/payments/terminalAvailability", () => ({
  kushkiTerminalSetup: m.setup,
  terminalDeviceUsable: (d: { active: boolean; serialNumber: string | null }, real: boolean) =>
    d.active && (!real || !!d.serialNumber),
}));
vi.mock("./prebillData", () => ({ loadPrebill: m.loadPrebill }));
vi.mock("./prebillQueue", () => ({ buildPrebillDocument: m.buildPrebill }));
vi.mock("./invoiceQueue", () => ({ buildInvoiceDocument: m.buildInvoice }));
vi.mock("./invoicePayments", () => ({ loadInvoicePaymentDetails: m.loadPayments }));
vi.mock("./shiftCloseQueue", () => ({ loadShiftCloseTicket: vi.fn() }));
// Parcial: los helpers de layout (fit, amountRow…) corren DE VERDAD — el
// diseño de los comandos es parte de lo que se prueba; a Kushki, jamás.
vi.mock("@/lib/env", () => ({ env: { KUSHKI_BP_BUSINESS_CODE: undefined, KUSHKI_CLOUD_TERMINAL_PATH: undefined } }));
vi.mock("@/lib/platformConfig", () => ({ getKushkiModeSync: () => "production" }));
vi.mock("@/lib/payments/kushki/cloudPrint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payments/kushki/cloudPrint")>()),
  printOnCloudTerminal: () => {
    throw new Error("nunca se llama a Kushki en los tests");
  },
  waitForCloudPrintJob: () => {
    throw new Error("nunca se llama a Kushki en los tests");
  },
}));

import { buildTerminalCommands, chooseTerminalDevice, listTerminalPrintDevices, printOnTerminalDevice } from "./terminalPrint";

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

  it("traduce TERMINAL_BUSY sin devolver el mensaje de Kushki", async () => {
    m.setup.mockResolvedValue({ mode: "sandbox", businessCode: "test", useRealTerminal: true });
    const send = vi.fn(async () => ({ ok: false, httpStatus: 400, printJobId: "job", errorCode: "TERMINAL_BUSY", message: "Terminal is busy" }));
    const result = await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target }, { send });
    expect(result).toEqual({ ok: false, error: "terminal_print_backoff" });
  });

  it.each([{ message: "timeout" }, { httpStatus: 504 }])("conserva el id y aplaza la impresión tras %o", async error => {
    m.setup.mockResolvedValue({ mode: "sandbox", businessCode: "test", useRealTerminal: true });
    const send = vi.fn(async () => ({ ok: false, printJobId: "job", ...error }));
    const result = await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target, printJobId: "job" }, { send });
    expect(result).toEqual({ ok: false, error: "terminal_print_backoff", printJobId: "job" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("mock (sin Business-Code): simula el envío, sin llamar a Kushki", async () => {
    const send = vi.fn();
    const r = await printOnTerminalDevice(
      { restaurantId: "rest-1", userId: "user-1", target },
      { send, isProduction: false },
    );
    expect(send).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      ok: true,
      deviceId: "A",
      deviceLabel: "Datáfono A",
      state: "printed",
      simulated: true,
      reference: "precuenta A4F2",
    });
  });

  it("en producción el mock no imprime", async () => {
    const r = await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target }, { isProduction: true });
    expect(r).toEqual({ ok: false, error: "mock_print_disabled" });
  });

  it("datáfono real: manda los comandos de la precuenta al serial y espera el COMPLETED", async () => {
    m.setup.mockResolvedValue({ mode: "production", businessCode: "BC-1", useRealTerminal: true });
    const send = vi.fn(async () => ({ ok: true, printJobId: "job-1", status: "PENDING" }));
    const waitJob = vi.fn(async () => ({ state: "completed" as const }));
    const r = await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target }, { send, waitJob });
    expect(waitJob).toHaveBeenCalledWith({ serialNumber: "SN-A", businessCode: "BC-1", mode: "production", printJobId: "job-1" });
    expect(send).toHaveBeenCalledOnce();
    const call = (send.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(call).toMatchObject({ serialNumber: "SN-A", businessCode: "BC-1", mode: "production", externalReference: "prebill-order-1" });
    const texts = (call.commands as Array<{ type: string; text?: string }>).map((c) => c.text ?? c.type).join("|");
    expect(texts).toContain("PRECUENTA");
    expect(texts).toContain("cut");
    expect(m.audit).toHaveBeenCalledWith({ data: expect.objectContaining({
      restaurantId: "rest-1", kind: "terminal.print.completed", targetId: "SN-A", diff: { jobId: "job-1" },
    }) });
    expect(r).toMatchObject({ ok: true, printJobId: "job-1", state: "printed", simulated: false });
  });

  it("202 pero el datáfono no la imprime en el tiempo: queda encolada (no «impresa»)", async () => {
    m.setup.mockResolvedValue({ mode: "production", businessCode: "BC-1", useRealTerminal: true });
    const send = vi.fn(async () => ({ ok: true, printJobId: "job-1", status: "PENDING" }));
    const waitJob = vi.fn(async () => ({ state: "pending" as const, lastStatus: "PENDING" as const }));
    expect(await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target }, { send, waitJob })).toMatchObject({
      ok: true,
      state: "queued",
      printJobId: "job-1",
    });
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("FAILED (sin papel): print_failed con el código del datáfono", async () => {
    m.setup.mockResolvedValue({ mode: "production", businessCode: "BC-1", useRealTerminal: true });
    const send = vi.fn(async () => ({ ok: true, printJobId: "job-1", status: "PENDING" }));
    const waitJob = vi.fn(async () => ({ state: "failed" as const, errorCode: "OUT_OF_PAPER", errorMessage: "Sin papel" }));
    expect(await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target }, { send, waitJob })).toEqual({
      ok: false,
      error: "print_failed",
      reason: "OUT_OF_PAPER",
      errorCode: "OUT_OF_PAPER",
      errorMessage: "Sin papel",
      printJobId: "job-1",
    });
  });

  it("reintento: el MISMO printJobId (el datáfono no imprime doble)", async () => {
    m.setup.mockResolvedValue({ mode: "production", businessCode: "BC-1", useRealTerminal: true });
    const send = vi.fn(async () => ({ ok: true, printJobId: "job-9", status: "PENDING" }));
    const waitJob = vi.fn(async () => ({ state: "completed" as const }));
    await printOnTerminalDevice({ restaurantId: "rest-1", userId: "u", target, printJobId: "job-9" }, { send, waitJob });
    expect(((send.mock.calls[0] as unknown[])[0] as Record<string, unknown>).printJobId).toBe("job-9");
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
      printJobId: "job-1",
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

describe("¿hay datáfonos para ofrecer «Datáfono»?", () => {
  it("los usables, en orden; ninguno sin Business-Code o con el mock en producción", async () => {
    m.devices.mockResolvedValue([dev("A"), dev("B", { serialNumber: null })]);
    expect(await listTerminalPrintDevices("rest-1", { isProduction: false })).toEqual([
      { id: "A", label: "Datáfono A" },
      { id: "B", label: "Datáfono B" },
    ]);
    m.setup.mockResolvedValue({ mode: "production", businessCode: "BC-1", useRealTerminal: true });
    expect(await listTerminalPrintDevices("rest-1")).toEqual([{ id: "A", label: "Datáfono A" }]);
    m.setup.mockResolvedValue({ mode: "production", businessCode: null, useRealTerminal: true });
    expect(await listTerminalPrintDevices("rest-1")).toEqual([]);
    m.setup.mockResolvedValue({ mode: "mock", businessCode: null, useRealTerminal: false });
    expect(await listTerminalPrintDevices("rest-1", { isProduction: true })).toEqual([]);
  });
});


describe("la factura en el datáfono lleva la sección «Pagos» (regresión FESM8525)", () => {
  it("carga los pagos CON detalle, se los pasa al documento y los comandos imprimen la sección", async () => {
    m.invoiceRow.mockResolvedValue({
      id: "inv-1",
      restaurantId: "rest-1",
      orderId: "order-1",
      invoiceNumber: 8525,
      snapshot: { invoicePrefix: "FESM" },
      order: { locale: "es" },
      dianDocument: null,
      restaurant: { enabledModules: [], country: "CO" },
    });
    const details = [
      {
        method: "kushki_card_terminal",
        amountCents: 3_703_900,
        tipCents: 313_900,
        cardBrand: "VISA",
        cardLast4: "4242",
        approvalCode: "123456",
      },
    ];
    m.loadPayments.mockResolvedValue(details);
    // El documento que armaría `buildInvoiceDocument` con ese detalle:
    // trae la sección y el bloque viejo vacío (contrato de #634).
    m.buildInvoice.mockResolvedValue({
      paperWidthMm: 58,
      businessName: "SON Y MELONA S.A.S.",
      businessLines: [],
      documentLabel: "FACTURA ELECTRÓNICA DE VENTA",
      documentNumber: "FESM8525",
      metaRows: [],
      customerLines: [],
      items: [],
      totals: [{ label: "TOTAL A PAGAR", amount: "$ 37,039", strong: true }],
      paymentTitle: null,
      paymentRows: [],
      paymentsSection: {
        title: "Pagos",
        blocks: [
          {
            label: "Tarjeta · datáfono",
            amount: "$ 37,039",
            lines: ["VISA · ····4242 · Aprob. 123456"],
          },
        ],
        totalLabel: "TOTAL PAGADO",
        totalAmount: "$ 37,039",
        breakdown: null,
        pending: null,
      },
      footerLines: [],
      fiscal: null,
    });

    const built = await buildTerminalCommands("rest-1", { kind: "invoice", orderId: "order-1" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // El detalle viene del loader único y viaja como `paymentDetails`.
    expect(m.loadPayments).toHaveBeenCalledWith("order-1");
    expect(m.buildInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ payments: details, paymentDetails: details }),
    );
    const texts = built.commands
      .flatMap((c) => (c.type === "text" ? [c.text] : c.type === "columns" ? c.columns.map((col) => col.text) : []))
      .join("\n");
    expect(texts).toContain("TOTAL PAGADO");
    expect(texts).toContain("Tarjeta · datáfono");
    expect(texts).not.toContain("Forma de pago");
    // Y el rótulo largo va envuelto por palabra, no crudo.
    expect(texts).toContain("FACTURA ELECTRÓNICA DE\nVENTA");
  });
});
