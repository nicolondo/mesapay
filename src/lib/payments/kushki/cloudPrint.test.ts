import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { KUSHKI_BP_BUSINESS_CODE: undefined, KUSHKI_CLOUD_TERMINAL_PATH: undefined } }));
vi.mock("@/lib/platformConfig", () => ({ getKushkiModeSync: () => "production" }));
import { decryptData, tokenPassword } from "./cloudTerminal";
import {
  getCloudPrintJobStatus,
  printOnCloudTerminal,
  waitForCloudPrintJob,
  type CloudPrintJobState,
} from "./cloudPrint";

/**
 * El Print API cloud de Kushki ONE, según su contrato (2026-11-13): crear
 * es POST …/sync/print y un 202 es ENCOLADO (no impreso); el estado real
 * sale de POST …/sync/print_job con { print_job_id }. Se blinda la ruta, lo
 * que va cifrado, y el sondeo: «impresa» sólo con COMPLETED. Nunca se llama
 * a Kushki: `fetch` es de mentira.
 */

const target = { serialNumber: "SN-1", businessCode: "BC-1", mode: "production" as const };

type Call = { url: string; payload: Record<string, unknown> };

/** Un relay de mentira que descifra lo que recibe y responde lo pedido. */
function relay(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const ts = Number(init.headers.timestamp);
    const password = tokenPassword("BC-1" + "SN-1", ts);
    const { data } = JSON.parse(init.body) as { data: string };
    calls.push({ url, payload: JSON.parse(decryptData(data, ts, password)) });
    const r = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  return { fn, calls };
}

let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  log.mockRestore();
  err.mockRestore();
});

describe("crear el trabajo: POST …/sync/print", () => {
  it("la ruta del contrato y el cuerpo cifrado { printJobId, commands, externalReference } (sin skipIfBusy)", async () => {
    const r = relay([{ status: 202, body: { printJobId: "job-1", status: "PENDING", message: "Impresión encolada correctamente." } }]);
    vi.stubGlobal("fetch", r.fn);
    const out = await printOnCloudTerminal({
      ...target,
      printJobId: "job-1",
      externalReference: "prebill-o-1",
      commands: [{ type: "text", text: "Hola\n", align: "CENTER", size: 24 }, { type: "feed", lines: 3 }, { type: "cut" }],
    });
    expect(r.calls[0].url).toMatch(/\/terminal\/v1\/SN-1\/sync\/print$/);
    expect(r.calls[0].payload).toEqual({
      printJobId: "job-1",
      externalReference: "prebill-o-1",
      commands: [{ type: "text", text: "Hola\n", align: "CENTER", size: 24 }, { type: "feed", lines: 3 }, { type: "cut" }],
    });
    // 202 = encolado, no impreso.
    expect(out).toMatchObject({ ok: true, printJobId: "job-1", status: "PENDING", httpStatus: 202 });
    // La respuesta 2xx también queda en el log (sin el documento).
    expect(log).toHaveBeenCalledWith(
      "[kushki/cloud-print] encolada",
      expect.objectContaining({ httpStatus: 202, status: "PENDING", printJobId: "job-1" }),
    );
  });

  it("un 4xx no es ok y se registra con el cuerpo", async () => {
    vi.stubGlobal("fetch", relay([{ status: 400, body: { code: "PRINT-001", message: "invalid commands" } }]).fn);
    const out = await printOnCloudTerminal({ ...target, printJobId: "job-2", commands: [] });
    expect(out).toMatchObject({ ok: false, httpStatus: 400, message: "invalid commands" });
    expect(err).toHaveBeenCalledWith("[kushki/cloud-print] rechazada", expect.objectContaining({ httpStatus: 400 }));
  });

  it("sin respuesta (red caída) no lanza", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await printOnCloudTerminal({ ...target, printJobId: "job-3", commands: [] })).toMatchObject({
      ok: false,
      message: "network_error",
    });
  });
});

describe("estado del trabajo: POST …/sync/print_job", () => {
  it("manda { print_job_id } en el cuerpo y lee status, errorCode y errorMessage", async () => {
    const r = relay([{ status: 200, body: { printJobId: "job-1", status: "FAILED", errorCode: "OUT_OF_PAPER", errorMessage: "Sin papel" } }]);
    vi.stubGlobal("fetch", r.fn);
    const st = await getCloudPrintJobStatus({ ...target, printJobId: "job-1" });
    expect(r.calls[0].url).toMatch(/\/terminal\/v1\/SN-1\/sync\/print_job$/);
    expect(r.calls[0].payload).toEqual({ print_job_id: "job-1" });
    expect(st).toEqual({ ok: true, httpStatus: 200, status: "FAILED", errorCode: "OUT_OF_PAPER", errorMessage: "Sin papel" });
  });

  it("404 (no existe) no es un estado", async () => {
    vi.stubGlobal("fetch", relay([{ status: 404, body: { message: "not found" } }]).fn);
    expect(await getCloudPrintJobStatus({ ...target, printJobId: "x" })).toEqual({ ok: false, httpStatus: 404 });
  });
});

describe("esperar el resultado real", () => {
  /** Reloj y sueño de mentira: cada sueño avanza el reloj. */
  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  }
  const seq = (...states: CloudPrintJobState[]) => {
    const list = [...states];
    return vi.fn(async () => list.shift() ?? states[states.length - 1]);
  };

  it("202 → PENDING → IN_PROGRESS → COMPLETED: impresa", async () => {
    const getStatus = seq(
      { ok: true, status: "PENDING" },
      { ok: true, status: "IN_PROGRESS" },
      { ok: true, status: "COMPLETED" },
    );
    expect(await waitForCloudPrintJob({ ...target, printJobId: "j" }, { ...clock(), getStatus })).toEqual({ state: "completed" });
    expect(getStatus).toHaveBeenCalledTimes(3);
  });

  it("FAILED con OUT_OF_PAPER: falló, con el código", async () => {
    const getStatus = seq({ ok: true, status: "FAILED", errorCode: "OUT_OF_PAPER", errorMessage: "Sin papel" });
    expect(await waitForCloudPrintJob({ ...target, printJobId: "j" }, { ...clock(), getStatus })).toEqual({
      state: "failed",
      errorCode: "OUT_OF_PAPER",
      errorMessage: "Sin papel",
    });
  });

  it("sigue PENDING al vencer ~30 s: queda encolada (se reintenta con el mismo id)", async () => {
    const getStatus = seq({ ok: true, status: "PENDING" });
    const out = await waitForCloudPrintJob({ ...target, printJobId: "j" }, { ...clock(), getStatus, intervalMs: 2500, timeoutMs: 30_000 });
    expect(out).toEqual({ state: "pending", lastStatus: "PENDING" });
    expect(getStatus.mock.calls.length).toBe(12);
  });

  it("un error del sondeo no corta: se vuelve a preguntar", async () => {
    const getStatus = seq({ ok: false, error: "timeout" }, { ok: false, httpStatus: 500 }, { ok: true, status: "COMPLETED" });
    expect(await waitForCloudPrintJob({ ...target, printJobId: "j" }, { ...clock(), getStatus })).toEqual({ state: "completed" });
  });
});
