// Cómo se lee la respuesta del Cloud Terminal de Kushki. Lo que importa es
// separar "no se cobró" (aprobado/rechazado/solicitud no validada) de "no se
// sabe" (transporte): sólo lo segundo deja el pago incierto. Nunca llama a
// Kushki: `fetch` es un doble.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    KUSHKI_BP_BUSINESS_CODE: undefined,
    KUSHKI_CLOUD_TERMINAL_PATH: undefined,
    KUSHKI_CLOUD_TERMINAL_DEVICE: "SUNMI-T2",
  },
}));
vi.mock("@/lib/platformConfig", () => ({ getKushkiModeSync: () => "production" }));

import { CLOUD_TERMINAL_VALIDATION_STATUSES, pushPaymentToCloudTerminal } from "./cloudTerminal";

const fetchMock = vi.fn();
const respond = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(body === undefined ? "" : JSON.stringify(body), { status }));

const push = () =>
  pushPaymentToCloudTerminal({
    serialNumber: "P3F6P624J0139",
    amountCents: 6_589_000,
    reference: "cmvx2t4va0001g2znoepu6k0u",
    businessCode: "bc-test",
    mode: "production",
  });

// El cuerpo real de Son y Melona (2026-10-31).
const VALIDATION_ERROR = {
  type: "INTERNAL",
  code: "CLOUDPAYMENT_VALIDATION_ERROR",
  message: "Unable to validate the CloudPayment request.",
  object: { terminal_id: 4716 },
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pushPaymentToCloudTerminal: Kushki no validó la solicitud (4xx)", () => {
  it("el caso real: 400 CLOUDPAYMENT_VALIDATION_ERROR → rejected, con el código y el mensaje de Kushki", async () => {
    respond(400, VALIDATION_ERROR);
    const result = await push();
    expect(result).toMatchObject({
      status: "rejected",
      httpStatus: 400,
      failure: { type: "INTERNAL", code: "CLOUDPAYMENT_VALIDATION_ERROR", message: "Unable to validate the CloudPayment request." },
    });
    expect(result.message).toContain("CLOUDPAYMENT_VALIDATION_ERROR");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://cloudt.kushkipagos.com/terminal/v1/P3F6P624J0139/sync/charge");
  });

  it.each([400, 401, 403, 404, 409, 422])("HTTP %i → rejected (nunca llegó al equipo)", async (status) => {
    respond(status, { failure: { type: "INTERNAL", code: `E${status}`, message: "nope" } });
    expect(await push()).toMatchObject({ status: "rejected", httpStatus: status, failure: { code: `E${status}` } });
  });

  it("un 4xx sin cuerpo también es rechazo de validación", async () => {
    respond(401, undefined);
    expect(await push()).toMatchObject({ status: "rejected", httpStatus: 401, message: "http_401" });
  });

  it("la lista es exactamente 400, 401, 403, 404, 409 y 422", () => {
    expect([...CLOUD_TERMINAL_VALIDATION_STATUSES].sort((a, b) => a - b)).toEqual([400, 401, 403, 404, 409, 422]);
  });

  it("un rechazo de la tarjeta con 4xx sigue siendo declined (banco), no rejected", async () => {
    respond(400, { approved: false, failure: { code: "005", message: "Tarjeta rechazada" } });
    expect(await push()).toMatchObject({ status: "declined" });
  });
});

describe("pushPaymentToCloudTerminal: lo incierto sigue incierto", () => {
  it.each([500, 502, 503, 504, 408, 429])("HTTP %i → error (no se sabe si el equipo cobró)", async (status) => {
    respond(status, { type: "INTERNAL", code: "UPSTREAM", message: "boom" });
    expect(await push()).toMatchObject({ status: "error", httpStatus: status });
  });

  it("error de red → error network_error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await push()).toMatchObject({ status: "error", message: "network_error" });
  });

  it("timeout → error timeout", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    expect(await push()).toMatchObject({ status: "error", message: "timeout" });
  });

  it("HTTP 200 sin señal de aprobado (el cliente canceló en el equipo) → error, como antes", async () => {
    respond(200, { type: "TERMINAL-SUNMI", code: "-1", message: "User cancel the process" });
    expect(await push()).toMatchObject({ status: "error", httpStatus: 200 });
  });
});

describe("pushPaymentToCloudTerminal: aprobado y rechazado del banco", () => {
  it("aprobado sólo con señal explícita", async () => {
    respond(200, { approved: true, transaction_reference: "tx-1", message: "ok" });
    expect(await push()).toMatchObject({ status: "approved", providerRef: "tx-1" });
  });

  it("DECLINED → declined", async () => {
    respond(200, { rawResponse: { transaction_status: "DECLINED", transaction_reference: "tx-2" } });
    expect(await push()).toMatchObject({ status: "declined", providerRef: "tx-2" });
  });
});
