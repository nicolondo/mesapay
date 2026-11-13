// Quien habla con Kushki por Bre-B, y el token de PSE en modo
// multiprocesador. Nunca sale a la red: `fetch` es un doble que responde con
// la forma del contrato.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: { NODE_ENV: "test" }, requireKushkiKey: () => "partner-fake" }));
vi.mock("@/lib/platformConfig", () => ({ getKushkiModeSync: () => "sandbox" }));

import {
  breBFailureKind,
  breBGatewayFor,
  breBStartError,
  isBreBAlreadyFinal,
} from "./gateway";
import { KushkiHttpError } from "../kushki/client";
import { BreBContractError } from "../kushki/breB";
import { clearTransferConfigCache } from "../kushki/transferConfig";
import { buildPseTokenBody, isProcessorMismatch, requestPseTokenForMultiProcessor } from "../kushki/pseToken";
import { LiveKushkiProvider } from "../kushki/live";
import {
  CONFIG_BRE_B_ONLY,
  CONFIG_MULTI,
  CONFIG_PSE_ONLY,
  INIT_RESPONSE,
  QR_DATA_URI,
  TOKEN_RESPONSE,
  kushkiError,
  statusResponse,
} from "../kushki/__fixtures__/breB";

const fetchMock = vi.fn();
type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
const calls = (): Call[] =>
  (fetchMock.mock.calls as Array<[string, RequestInit]>).map(([url, init]) => ({
    url,
    method: init.method ?? "GET",
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(String(init.body)) : undefined,
  }));
const respond = (status: number, body?: unknown) =>
  fetchMock.mockResolvedValueOnce(
    new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), { status }),
  );

const CREDS = { publicKey: "pub-breb-fake", privateKey: "priv-breb-fake" };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  clearTransferConfigCache();
});
afterEach(() => vi.unstubAllGlobals());

describe("gateway Bre-B en vivo (UAT simulado)", () => {
  it("config → token con el procesador copiado → init: headers, rutas y cuerpos del contrato", async () => {
    const gw = breBGatewayFor("sandbox", CREDS);
    respond(200, CONFIG_BRE_B_ONLY);
    const processor = await gw.processor();
    expect(processor).toEqual({ name: "Bre-B Credibanco Processor", channel: "QR" });
    respond(201, TOKEN_RESPONSE);
    const { token } = await gw.requestToken({ amountCents: 4_550_000, currency: "COP", processor: processor! });
    respond(201, INIT_RESPONSE);
    const init = await gw.init({ token, amountCents: 4_550_000, metadata: { chargeId: "c1", paymentId: "p1" } });
    expect(init.qrImage).toBe(QR_DATA_URI);

    const [config, tok, ini] = calls();
    expect(config.url).toBe("https://api-uat.kushkipagos.com/transfer/v1/config?paymentType=PAYMENT");
    expect(config.method).toBe("GET");
    expect(config.headers["Public-Merchant-Id"]).toBe("pub-breb-fake");
    expect(config.headers["Private-Merchant-Id"]).toBeUndefined();

    expect(tok.url).toBe("https://api-uat.kushkipagos.com/transfer/v1/tokens");
    expect(tok.headers["Public-Merchant-Id"]).toBe("pub-breb-fake");
    expect(tok.body).toMatchObject({
      currency: "COP",
      amount: { subtotalIva0: 45500 },
      processor: { name: "Bre-B Credibanco Processor", channel: "QR" },
    });

    expect(ini.url).toBe("https://api-uat.kushkipagos.com/transfer/v1/init");
    expect(ini.headers["Private-Merchant-Id"]).toBe("priv-breb-fake");
    expect(ini.headers["Public-Merchant-Id"]).toBeUndefined();
    expect(ini.body).toMatchObject({ token: TOKEN_RESPONSE.token, amount: { subtotalIva0: 45500 } });
  });

  it("la config se cachea por comercio; `fresh` la vuelve a leer y `forgetProcessor` la olvida", async () => {
    const gw = breBGatewayFor("sandbox", CREDS);
    respond(200, CONFIG_BRE_B_ONLY);
    await gw.processor();
    await gw.processor();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    respond(200, CONFIG_PSE_ONLY);
    expect(await gw.processor({ fresh: true })).toBeNull();
    gw.forgetProcessor();
    respond(200, CONFIG_BRE_B_ONLY);
    expect(await gw.processor()).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("status y cancel van con la llave privada; cancel es PATCH sin cuerpo y 204", async () => {
    const gw = breBGatewayFor("production", CREDS);
    respond(200, statusResponse("approvedTransaction"));
    expect((await gw.status("tok")).status).toBe("approved");
    respond(204);
    await gw.cancel("tok");
    const [status, cancel] = calls();
    expect(status.url).toBe("https://api.kushkipagos.com/transfer/v1/status/tok");
    expect(status.headers["Private-Merchant-Id"]).toBe("priv-breb-fake");
    expect(cancel.method).toBe("PATCH");
    expect(cancel.url).toBe("https://api.kushkipagos.com/transfer/v1/cancel/tok");
    expect(cancel.body).toBeUndefined();
  });

  it("sin llaves no hay gateway real; en mock no sale ninguna petición", async () => {
    expect(() => breBGatewayFor("sandbox", null)).toThrow("bre_b_not_configured");
    const mock = breBGatewayFor("mock", null);
    const processor = await mock.processor();
    const { token } = await mock.requestToken({ amountCents: 100_00, currency: "COP", processor: processor! });
    const init = await mock.init({ token, amountCents: 100_00, metadata: { chargeId: "c" } });
    expect(init.qrImage.startsWith("data:image/png;base64,")).toBe(true);
    expect((await mock.status(token)).status).toBe("pending");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("errores de Kushki → qué se sabe", () => {
  const http = (status: number, code?: string) =>
    new KushkiHttpError(status, code ? kushkiError(code) : "", "https://api-uat.kushkipagos.com/x");

  it.each([
    [http(401), "rejected", "bre_b_credentials_invalid"],
    [http(422, "E046"), "rejected", "bre_b_processor_mismatch"],
    [http(404, "E049"), "rejected", "bre_b_keys_missing"],
    [http(400, "E001"), "rejected", "bre_b_rejected"],
    [http(500, "E002"), "unknown", "bre_b_unavailable"],
    [http(502), "unknown", "bre_b_unavailable"],
    [new BreBContractError("init", "qr_not_png_data_uri"), "unparseable", "bre_b_unavailable"],
    [new TypeError("fetch failed"), "unknown", "bre_b_unavailable"],
  ])("%s → %s / %s", (err, kind, code) => {
    expect(breBFailureKind(err)).toBe(kind);
    expect(breBStartError(err)).toBe(code);
  });

  it("400 T023 al cancelar = ya está en un estado final", () => {
    expect(isBreBAlreadyFinal(http(400, "T023"))).toBe(true);
    expect(isBreBAlreadyFinal(http(400, "E001"))).toBe(false);
    expect(isBreBAlreadyFinal(http(500, "T023"))).toBe(false);
  });

  it("una respuesta 2xx que no cumple el contrato no se reintenta ni se acepta", async () => {
    const gw = breBGatewayFor("sandbox", CREDS);
    respond(201, { qr: "https://evil.example/qr.png" });
    await expect(gw.init({ token: "t", amountCents: 100_00, metadata: { chargeId: "c" } })).rejects.toBeInstanceOf(
      BreBContractError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("init y token no se repiten solos en un 5xx (cada intento crea otro QR)", async () => {
    const gw = breBGatewayFor("sandbox", CREDS);
    respond(503, "down");
    await expect(gw.init({ token: "t", amountCents: 100_00, metadata: { chargeId: "c" } })).rejects.toBeInstanceOf(
      KushkiHttpError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("PSE en modo multiprocesador", () => {
  const input = {
    amountCents: 4_550_000,
    currency: "COP",
    callbackUrl: "https://mesapay.co/t/x/pay/o/pse-return?pid=p",
    buyer: { email: "a@example.test", docType: "CC", docNumber: "12345678", personType: "natural" },
    bankCode: "1007",
  };

  it("el cuerpo de PSE sólo lleva `processor: { name }` cuando hay más de un procesador", () => {
    expect(buildPseTokenBody(input)).not.toHaveProperty("processor");
    expect(buildPseTokenBody(input, { name: "Pse Processor" }).processor).toEqual({ name: "Pse Processor" });
    // Nunca el canal (es de Bre-B) ni nada más.
    expect(buildPseTokenBody(input, { name: "Pse Processor", channel: "QR" }).processor).toEqual({
      name: "Pse Processor",
    });
  });

  it("comercio con PSE solo: el token del servidor sale como siempre, sin `processor`", async () => {
    respond(200, CONFIG_PSE_ONLY);
    respond(201, { token: "pse-tok" });
    const provider = new LiveKushkiProvider("sandbox");
    await provider.initiatePse({
      merchantId: "pub-card-fake",
      amount: { amountCents: 4_550_000, currency: "COP" },
      buyer: { email: "a@example.test", docType: "CC", docNumber: "12345678", personType: "natural" },
      bankCode: "1007",
      callbackUrl: input.callbackUrl,
      metadata: { orderId: "o", paymentId: "p" },
    });
    const token = calls().find((c) => c.url.endsWith("/transfer/v1/tokens"))!;
    expect(token.body).not.toHaveProperty("processor");
    expect(token.body).toMatchObject({ bankId: "1007", documentNumber: "12345678" });
  });

  it("comercio con PSE y Bre-B: el token de PSE lleva el procesador de PSE del config", async () => {
    respond(200, CONFIG_MULTI);
    respond(201, { token: "pse-tok" });
    const provider = new LiveKushkiProvider("sandbox");
    await provider.initiatePse({
      merchantId: "pub-card-fake",
      amount: { amountCents: 4_550_000, currency: "COP" },
      buyer: { email: "a@example.test", docType: "CC", docNumber: "12345678", personType: "natural" },
      bankCode: "1007",
      callbackUrl: input.callbackUrl,
      metadata: { orderId: "o", paymentId: "p" },
    });
    const token = calls().find((c) => c.url.endsWith("/transfer/v1/tokens"))!;
    expect(token.body).toMatchObject({ processor: { name: "Pse Processor" }, bankId: "1007" });
  });

  it("si la config no responde, PSE no se rompe: el token sale sin `processor`", async () => {
    respond(500, "boom");
    respond(500, "boom");
    respond(201, { token: "pse-tok" });
    const provider = new LiveKushkiProvider("sandbox");
    const result = await provider.initiatePse({
      merchantId: "pub-card-fake",
      amount: { amountCents: 100_00, currency: "COP" },
      buyer: { email: "a@example.test", docType: "CC", docNumber: "12345678", personType: "natural" },
      bankCode: "1007",
      callbackUrl: input.callbackUrl,
      metadata: { orderId: "o", paymentId: "p" },
    });
    expect(result.providerRef).toBe("pse-tok");
    const token = calls().find((c) => c.url.endsWith("/transfer/v1/tokens"))!;
    expect(token.body).not.toHaveProperty("processor");
  });

  it("reintento tras E046: sólo en modo multiprocesador pide un token nuevo con el procesador de PSE", async () => {
    expect(isProcessorMismatch(new KushkiHttpError(422, kushkiError("E046"), "u"))).toBe(true);
    expect(isProcessorMismatch(new KushkiHttpError(422, kushkiError("E049"), "u"))).toBe(false);

    respond(200, CONFIG_PSE_ONLY);
    expect(await requestPseTokenForMultiProcessor("sandbox", "pub-card-fake", input)).toBeNull();
    expect(calls().some((c) => c.url.endsWith("/transfer/v1/tokens"))).toBe(false);

    fetchMock.mockReset();
    respond(200, CONFIG_MULTI);
    respond(201, { token: "pse-tok-2" });
    expect(await requestPseTokenForMultiProcessor("sandbox", "pub-card-fake", input)).toBe("pse-tok-2");
    const token = calls().find((c) => c.url.endsWith("/transfer/v1/tokens"))!;
    expect(token.headers["Public-Merchant-Id"]).toBe("pub-card-fake");
    expect(token.body).toMatchObject({ processor: { name: "Pse Processor" } });
  });
});
