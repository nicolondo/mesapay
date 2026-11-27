import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeferredTerminalPrint } from "./deferredTerminalPrint";
import { printOnTerminal } from "./terminalPrintClient";

const doc = { kind: "invoice" as const, orderId: "order", href: "/factura/test" };
const hold = (retryAfterMs: number) => ({ via: "post_approval" as const, retryAfterMs, deviceId: "device", printJobId: "job" });
const printed = { via: "terminal" as const, state: "printed" as const, deviceId: "device", printJobId: "job", deviceLabel: "Caja", simulated: true };

describe("impresión diferida después de aprobar", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("agrupa los toques y reprograma sólo el margen que indique el servidor para el mismo trabajo", async () => {
    const send = vi.fn<typeof printOnTerminal>().mockResolvedValueOnce(hold(4500)).mockResolvedValueOnce(hold(1800)).mockResolvedValue(printed);
    const update = vi.fn();
    const schedule = new DeferredTerminalPrint(update, send);
    const action = schedule.run(doc);
    expect(await schedule.run(doc)).toBeNull();
    await vi.advanceTimersByTimeAsync(4499);
    expect(send).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith(1);
    expect(await schedule.run(doc)).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenLastCalledWith(doc, { deviceId: "device", printJobId: "job" });
    await vi.advanceTimersByTimeAsync(1799);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await action).toEqual(printed);
    expect(send).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenLastCalledWith(null);
  });

  it.each([false, true])("cancelar o salir descarta incluso el 409 tardío (esperando: %s)", async waiting => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn<typeof printOnTerminal>().mockResolvedValue(hold(20_000));
    const schedule = new DeferredTerminalPrint(vi.fn(), send);
    const action = schedule.run(doc);
    if (waiting) await vi.advanceTimersByTimeAsync(0);
    schedule.cancel();
    if (waiting) expect(warn).not.toHaveBeenCalled();
    else expect(warn).toHaveBeenCalledWith("[terminal] print_cancelled_during_send", expect.objectContaining({
      kind: "invoice", documentId: "order",
    }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await action).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("cancelar desde el aviso deja libre el control y descarta la impresión pendiente", async () => {
    const send = vi.fn<typeof printOnTerminal>().mockResolvedValueOnce(hold(6000)).mockResolvedValue(printed);
    const schedule = new DeferredTerminalPrint(vi.fn(), send);
    const action = schedule.run(doc);
    await vi.advanceTimersByTimeAsync(2000);
    schedule.cancelWaiting();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await action).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await schedule.run(doc)).toEqual(printed);
  });

  it("si otro documento está imprimiéndose, solo la solicitud ya diferida espera su turno", async () => {
    const printing = { via: "printing" as const };
    const send = vi.fn<typeof printOnTerminal>().mockResolvedValueOnce(printing)
      .mockResolvedValueOnce(hold(2000)).mockResolvedValueOnce(printing).mockResolvedValueOnce(printed);
    const schedule = new DeferredTerminalPrint(vi.fn(), send);
    expect(await schedule.run(doc)).toEqual({ via: "error", code: "terminal_printing" });
    const action = schedule.run(doc);
    await vi.advanceTimersByTimeAsync(6999);
    expect(send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(await action).toEqual(printed);
    expect(send.mock.calls.slice(2)).toEqual(Array(2).fill([doc, { deviceId: "device", printJobId: "job" }]));
  });

  it.each([
    [hold(9000), "terminal_post_approval"],
    [{ via: "printing" as const }, "terminal_printing"],
  ] as const)("el mismo toque tiene un plazo total aunque se repita %o", async (conflict, code) => {
    const send = vi.fn<typeof printOnTerminal>().mockResolvedValueOnce(hold(10_000)).mockResolvedValue(conflict);
    const schedule = new DeferredTerminalPrint(vi.fn(), send);
    const action = schedule.run(doc);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await action).toEqual({ via: "error", code });
    const calls = send.mock.calls.length;
    expect(calls).toBeGreaterThan(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(calls);
  });

  it("al regresar a una pestaña vencida no despacha la impresión", async () => {
    const send = vi.fn<typeof printOnTerminal>().mockResolvedValueOnce(hold(10_000));
    const schedule = new DeferredTerminalPrint(vi.fn(), send);
    const action = schedule.run(doc);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 46_000);
    schedule.refresh();
    expect(await action).toEqual({ via: "error", code: "terminal_post_approval" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("al volver a la pestaña usa la hora real; ocupado termina el envío sin volver a intentarlo", async () => {
    const busy = { via: "error" as const, code: "terminal_print_backoff" };
    const send = vi.fn<typeof printOnTerminal>().mockResolvedValueOnce(hold(6000)).mockResolvedValue(busy);
    const schedule = new DeferredTerminalPrint(vi.fn(), send);
    const action = schedule.run(doc);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 8000);
    schedule.refresh();
    expect(schedule.sending).toBe(true);
    schedule.cancelWaiting(); // Un toque tardío conserva un envío que ya arrancó.
    schedule.refresh();
    expect(await action).toEqual(busy);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
