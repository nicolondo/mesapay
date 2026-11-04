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

import {
  CLOUD_TERMINAL_VALIDATION_STATUSES,
  cancelCloudTerminalPayment,
  cloudTerminalAmount,
  isTerminalCancelAnswer,
  isTerminalDeviceAnswer,
  decryptData,
  encryptPayload,
  pushPaymentToCloudTerminal,
  searchCloudTerminalCharge,
  terminalAnswerCode,
  tokenPassword,
} from "./cloudTerminal";

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

  it("HTTP 200 sin cuerpo → error sin respuesta del equipo", async () => {
    respond(200, undefined);
    const result = await push();
    expect(result).toMatchObject({ status: "error", httpStatus: 200 });
    expect(result.deviceAnswered).toBeUndefined();
  });

  it.each([
    ["TER-002 (el equipo no responde)", { type: "TERMINAL", code: "TER-002", message: "Terminal P3F6P624J0139 is not responding" }],
    ["TER-172 (se excedió el tiempo, tarjeta presentada)", { type: "TERMINAL", code: "TER-172", message: "The maximum operation time was exceeded." }],
    ["INTERNAL", { type: "INTERNAL", code: "INT-001", message: "Internal server error" }],
    ["un tipo desconocido", { type: "SOMETHING", code: "X1", message: "?" }],
  ])("HTTP 200 con %s → error SIN respuesta del equipo (puede haber cobrado)", async (_label, body) => {
    respond(200, body);
    const result = await push();
    expect(result).toMatchObject({ status: "error", httpStatus: 200 });
    expect(result.deviceAnswered).toBeUndefined();
  });

  it("un 5xx con un código del equipo sigue sin contar como respuesta", async () => {
    respond(503, { type: "TERMINAL", code: "TER-003", message: "busy" });
    const result = await push();
    expect(result).toMatchObject({ status: "error", httpStatus: 503 });
    expect(result.deviceAnswered).toBeUndefined();
  });
});

describe("pushPaymentToCloudTerminal: el datáfono canceló (Son y Melona, 2026-11-04)", () => {
  // El cuerpo real que contestó el equipo cuando la persona canceló.
  const REAL_CANCEL = {
    type: "TERMINAL",
    code: "TER-004",
    message: "User cancel the process",
    object: { client_transaction_id: "0b7c…", terminal_id: "123321", serial_number: "P3F6P624J0139" },
  };

  it("el caso real: HTTP 200 TERMINAL/TER-004 «User cancel the process» → canceled (no se cobró)", async () => {
    respond(200, REAL_CANCEL);
    const result = await push();
    expect(result).toMatchObject({
      status: "canceled",
      httpStatus: 200,
      deviceAnswered: true,
      failure: { type: "TERMINAL", code: "TER-004", message: "User cancel the process" },
    });
    expect(result.message).toContain("TER-004");
  });

  it("la forma vieja (TERMINAL-SUNMI / -1 «User cancel the process») → canceled", async () => {
    respond(200, { type: "TERMINAL-SUNMI", code: "-1", message: "User cancel the process" });
    expect(await push()).toMatchObject({ status: "canceled", deviceAnswered: true });
  });

  it("MAN-30005 (se venció la lectura de la tarjeta o el PIN) → canceled", async () => {
    respond(200, { type: "TERMINAL-SUNMI", code: "MAN-30005", message: "Input PIN timeout" });
    expect(await push()).toMatchObject({ status: "canceled", deviceAnswered: true });
  });

  it("TER-004 que NO llega con 200 no se da por cancelado (queda incierto)", async () => {
    respond(502, REAL_CANCEL);
    const result = await push();
    expect(result.status).toBe("error");
    expect(result.deviceAnswered).toBeUndefined();
  });

  it("un rechazo del banco con el mismo cuerpo sigue siendo declined", async () => {
    respond(200, { rawResponse: { transaction_status: "DECLINED" }, ...REAL_CANCEL });
    expect(await push()).toMatchObject({ status: "declined" });
  });

  it.each([
    ["TER-003 (ocupado con otra transacción)", { type: "TERMINAL", code: "TER-003", message: "Terminal is busy processing transaction" }],
    ["TER-001 (equipo no vinculado)", { type: "TERMINAL", code: "TER-001", message: "Terminal does not exist" }],
    ["ACQUIRER", { type: "ACQUIRER", code: "E020", message: "Either Invalid amount or Currency conversion field overflow" }],
    ["CONFIGURATION", { type: "CONFIGURATION", code: "CONF-4006", message: "Amount over limit" }],
    ["-1 genérico del equipo, sin «User cancel»", { type: "TERMINAL-SUNMI", code: "-1", message: "Card read error" }],
  ])("HTTP 200 con %s → error CON respuesta del equipo (se puede cerrar sin esperar)", async (_label, body) => {
    respond(200, body);
    expect(await push()).toMatchObject({ status: "error", httpStatus: 200, deviceAnswered: true, failure: { code: body.code } });
  });
});

describe("clasificación de las respuestas del equipo", () => {
  it("cancelación explícita: sólo TER-004, MAN-30005 y -1 con «User cancel»", () => {
    expect(isTerminalCancelAnswer({ type: "TERMINAL", code: "TER-004" })).toBe(true);
    expect(isTerminalCancelAnswer({ type: "terminal", code: "ter-004" })).toBe(true);
    expect(isTerminalCancelAnswer({ type: "TERMINAL-SUNMI", code: "MAN-30005" })).toBe(true);
    expect(isTerminalCancelAnswer({ type: "TERMINAL-SUNMI", code: "-1", message: "User cancel the process" })).toBe(true);
    expect(isTerminalCancelAnswer({ type: "TERMINAL-SUNMI", code: "-1", message: "Card read error" })).toBe(false);
    expect(isTerminalCancelAnswer({ type: "ACQUIRER", code: "TER-004" })).toBe(false);
    for (const code of ["TER-001", "TER-002", "TER-003", "TER-005", "TER-006", "TER-172"]) {
      expect(isTerminalCancelAnswer({ type: "TERMINAL", code })).toBe(false);
    }
    expect(isTerminalCancelAnswer(null)).toBe(false);
  });

  it("respuesta del equipo: sin código o sin tipo conocido no cuenta; TER-002/TER-172 tampoco", () => {
    expect(isTerminalDeviceAnswer({ type: "TERMINAL", code: "TER-003" })).toBe(true);
    expect(isTerminalDeviceAnswer({ type: "TERMINAL", code: "TER-002" })).toBe(false);
    expect(isTerminalDeviceAnswer({ type: "TERMINAL", code: "TER-172" })).toBe(false);
    expect(isTerminalDeviceAnswer({ type: "INTERNAL", code: "INT-001" })).toBe(false);
    expect(isTerminalDeviceAnswer({ type: "TERMINAL" })).toBe(false);
    expect(isTerminalDeviceAnswer({ code: "TER-003" })).toBe(false);
  });

  it("el código se guarda como TIPO/CÓDIGO", () => {
    expect(terminalAnswerCode({ type: "TERMINAL", code: "TER-004", message: "x" })).toBe("TERMINAL/TER-004");
    expect(terminalAnswerCode({ code: "TER-004" })).toBe("TER-004");
    expect(terminalAnswerCode(undefined)).toBeNull();
  });
});

describe("cancelCloudTerminalPayment (abort)", () => {
  it("firma la llamada y separa abortado / sin cobro activo / error", async () => {
    respond(200, {});
    expect(await cancelCloudTerminalPayment("P3F6P624J0139", "pay-1", "bc-test", "production")).toEqual({ status: "aborted", httpStatus: 200 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://cloudt.kushkipagos.com/terminal/v1/P3F6P624J0139/sync/abort");
    expect(init).toMatchObject({ method: "POST", headers: { Authorization: expect.stringMatching(/^Basic [0-9a-f]{128}$/), timestamp: expect.stringMatching(/^\d{10}$/) } });

    respond(409, { type: "TERMINAL", code: "TER-000", message: "No active transaction" });
    expect(await cancelCloudTerminalPayment("P3F6P624J0139", "pay-1", "bc-test", "production")).toEqual({ status: "not_active", httpStatus: 409 });

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await cancelCloudTerminalPayment("P3F6P624J0139", "pay-1", "bc-test", "production")).toEqual({ status: "error" });
  });

  it("sin serial no llama a Kushki", async () => {
    expect(await cancelCloudTerminalPayment("", "pay-1", "bc-test", "production")).toEqual({ status: "error" });
    expect(fetchMock).not.toHaveBeenCalled();
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

describe("pushPaymentToCloudTerminal: el monto que llega al datáfono", () => {
  it("producción manda pesos enteros: $91.850 es 91850, no 9185000 (Son y Melona, 2026-11-04)", () => {
    expect(cloudTerminalAmount(9_185_000, "production")).toBe(91_850);
  });

  it("UAT divide por 100, así que ahí siguen yendo los centavos", () => {
    expect(cloudTerminalAmount(9_185_000, "sandbox")).toBe(9_185_000);
  });

  it("el cobro de producción sale con el monto en pesos", async () => {
    respond(200, { approved: true, transaction_reference: "tx-1" });
    await push();
    expect(console.log).toHaveBeenCalledWith(
      "[kushki/cloud-terminal] charge",
      expect.objectContaining({ amountMinor: 65_890 }),
    );
  });

  it("aprobado con el monto autorizado igual al de la cuenta → approved", async () => {
    respond(200, { approved: true, rawResponse: { authorized_amount: 65_890, transaction_reference: "tx-3" } });
    expect(await push()).toMatchObject({ status: "approved", providerRef: "tx-3" });
  });

  it("aprobado con OTRO monto autorizado → error (incierto, a conciliar), nunca approved", async () => {
    respond(200, { approved: true, rawResponse: { authorized_amount: 6_589_000, transaction_reference: "tx-4" } });
    const result = await push();
    expect(result).toMatchObject({ status: "error", providerRef: "tx-4" });
    expect(result.message).toContain("authorized_amount_mismatch");
  });
});

describe("searchCloudTerminalCharge: el resultado real cuando el cobro no respondió (504, Son y Melona 2026-11-04)", () => {
  const CTX = "5c2a8e1b-7d3f-4b61-9a0e-2f4c6d8e0a1b";
  const search = (amountCents = 9_185_000, mode: "production" | "sandbox" = "production") =>
    searchCloudTerminalCharge({ serialNumber: "P3F6P624J0139", clientTransactionId: CTX, amountCents, businessCode: "bc-test", mode });
  const item = (over: Record<string, unknown> = {}) => ({
    transaction_reference: "tx-ref-1",
    client_transaction_id: CTX,
    transaction_type: "SALE",
    transaction_status: "APPROVAL",
    approval_code: "482913",
    approved_transaction_amount: 91_850,
    ...over,
  });

  it("consulta transaction_search_online firmado y cifrado, filtrando por el client_transaction_id y sin fechas", async () => {
    respond(200, { items: [] });
    expect(await search()).toEqual({ status: "not_found" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://cloudt.kushkipagos.com/terminal/v1/P3F6P624J0139/sync/transaction_search_online");
    const ts = Number(init.headers.timestamp);
    expect(init.headers.Authorization).toMatch(/^Basic [0-9a-f]{128}$/);
    const plain = JSON.parse(decryptData(JSON.parse(init.body).data, ts, tokenPassword("bc-testP3F6P624J0139", ts)));
    expect(plain).toEqual({ page: 1, size: 20, filters: { client_transaction_id: CTX, start_date: 0, end_date: 0 } });
  });

  it("venta APROBADA por el monto de la cuenta (en pesos) → approved con la referencia y el código", async () => {
    respond(200, { items: [item()] });
    expect(await search()).toMatchObject({ status: "approved", transactionReference: "tx-ref-1", approvalCode: "482913" });
  });

  it("la respuesta cifrada también se lee", async () => {
    fetchMock.mockImplementationOnce(async (_url: string, init: { headers: Record<string, string> }) => {
      const ts = Number(init.headers.timestamp);
      const data = encryptPayload(JSON.stringify({ items: [item()] }), ts, tokenPassword("bc-testP3F6P624J0139", ts));
      return new Response(JSON.stringify({ data }), { status: 200 });
    });
    expect(await search()).toMatchObject({ status: "approved" });
  });

  it("en UAT acepta el monto tal como se mandó (centavos)", async () => {
    respond(200, { items: [item({ approved_transaction_amount: 9_185_000 })] });
    expect(await search(9_185_000, "sandbox")).toMatchObject({ status: "approved" });
  });

  it("venta DECLINED → declined", async () => {
    respond(200, { items: [item({ transaction_status: "DECLINED", approved_transaction_amount: 0 })] });
    expect(await search()).toMatchObject({ status: "declined", transactionReference: "tx-ref-1" });
  });

  it("un aprobado por OTRO monto → unknown (a mano), nunca approved", async () => {
    respond(200, { items: [item({ approved_transaction_amount: 9_185_000 })] });
    expect(await search()).toMatchObject({ status: "unknown", reason: "amount_mismatch" });
  });

  it.each(["REVERSE", "VOID", "REFUND"])("una %s del mismo cobro → unknown (reversed)", async (type) => {
    respond(200, { items: [item(), item({ transaction_type: type, transaction_reference: "tx-ref-2" })] });
    expect(await search()).toMatchObject({ status: "unknown", reason: "reversed" });
  });

  it("ítems de otro cobro no cuentan", async () => {
    respond(200, { items: [item({ client_transaction_id: "otro" })] });
    expect(await search()).toEqual({ status: "not_found" });
  });

  it("un estado desconocido → unknown", async () => {
    respond(200, { items: [item({ transaction_status: "PENDING" })] });
    expect(await search()).toMatchObject({ status: "unknown", reason: "unrecognized" });
  });

  it("HTTP de error, cuerpo HTML o red caída → error (se reintenta, nunca se decide)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>504 Gateway Time-out</html>", { status: 504 }));
    expect(await search()).toMatchObject({ status: "error", httpStatus: 504 });
    respond(401, { type: "AUTH", code: "AUTH-001", message: "Invalid or expired credentials" });
    expect(await search()).toMatchObject({ status: "error", httpStatus: 401 });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await search()).toEqual({ status: "error" });
  });
});
