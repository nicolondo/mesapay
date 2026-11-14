// Adaptador del contrato «Transfer In» de Kushki para Bre-B. Sin red: arma
// peticiones y lee respuestas con la forma de la referencia (fixtures).
// Lo que NO cuadra con el contrato tiene que fallar CERRADO.
import { describe, expect, it } from "vitest";
import {
  BRE_B_CONTRACT_PENDING,
  BRE_B_CONTRACT_VERIFIED,
  BRE_B_PATHS,
  BRE_B_QR_TTL_SECONDS,
  BreBContractError,
  buildBreBCancelRequest,
  buildBreBInitRequest,
  buildBreBStatusRequest,
  buildBreBTokenRequest,
  buildTransferConfigRequest,
  isBreBQrImage,
  parseBreBInitResponse,
  parseBreBStatusResponse,
  parseBreBTokenResponse,
  parseBreBWebhook,
  parseTransferConfigResponse,
  readBreBWebhookReferences,
  readKushkiErrorCode,
  selectBreBProcessor,
  selectPseProcessor,
} from "./breB";
import {
  CONFIG_APM_WITHOUT_QR,
  CONFIG_BRE_B_ONLY,
  CONFIG_EMPTY,
  CONFIG_MULTI,
  CONFIG_PSE_ONLY,
  INIT_RESPONSE,
  PNG_BASE64,
  QR_DATA_URI,
  TOKEN_RESPONSE,
  kushkiError,
  statusResponse,
} from "./__fixtures__/breB";

describe("config de «Transfer In» (GET /transfer/v1/config?paymentType=PAYMENT)", () => {
  it("se pide con la llave PÚBLICA y paymentType=PAYMENT", () => {
    expect(buildTransferConfigRequest()).toEqual({
      method: "GET",
      path: "/transfer/v1/config?paymentType=PAYMENT",
      auth: "public",
    });
  });

  it("el procesador Bre-B es el APM con flujo PAYMENT por QR, con nombre y canal TAL CUAL", () => {
    const config = parseTransferConfigResponse(CONFIG_BRE_B_ONLY);
    expect(selectBreBProcessor(config)).toEqual({ name: "Bre-B Credibanco Processor", channel: "QR" });
  });

  it("no hay Bre-B: sólo PSE, lista vacía, o un APM sin cobro por QR", () => {
    expect(selectBreBProcessor(parseTransferConfigResponse(CONFIG_PSE_ONLY))).toBeNull();
    expect(selectBreBProcessor(parseTransferConfigResponse(CONFIG_EMPTY))).toBeNull();
    expect(selectBreBProcessor(parseTransferConfigResponse(CONFIG_APM_WITHOUT_QR))).toBeNull();
  });

  it("el nombre del procesador no está escrito a mano: se usa el que diga el config", () => {
    const renamed = {
      processors: [{ ...CONFIG_BRE_B_ONLY.processors[0], name: "Otro Nombre De Kushki" }],
    };
    expect(selectBreBProcessor(parseTransferConfigResponse(renamed))?.name).toBe("Otro Nombre De Kushki");
  });

  it("dos APM con QR: se elige el que se llama Bre-B; si ninguno, no se adivina", () => {
    const other = { ...CONFIG_BRE_B_ONLY.processors[0], name: "Otro APM QR" };
    const both = { processors: [other, ...CONFIG_BRE_B_ONLY.processors] };
    expect(selectBreBProcessor(parseTransferConfigResponse(both))?.name).toBe("Bre-B Credibanco Processor");
    const ambiguous = { processors: [other, { ...other, name: "Tercer APM" }] };
    expect(selectBreBProcessor(parseTransferConfigResponse(ambiguous))).toBeNull();
  });

  it("modo multiprocesador: PSE lleva { name } sin channel; con PSE solo, nada", () => {
    expect(selectPseProcessor(parseTransferConfigResponse(CONFIG_PSE_ONLY))).toBeNull();
    expect(selectPseProcessor(parseTransferConfigResponse(CONFIG_MULTI))).toEqual({ name: "Pse Processor" });
    expect(selectPseProcessor(parseTransferConfigResponse(CONFIG_BRE_B_ONLY))).toBeNull();
  });

  it("una config con otra forma falla cerrado", () => {
    expect(() => parseTransferConfigResponse({})).toThrow(BreBContractError);
    expect(() => parseTransferConfigResponse({ processors: [{ currency: "COP" }] })).toThrow(BreBContractError);
    expect(() => parseTransferConfigResponse("<html>")).toThrow(BreBContractError);
  });
});

describe("token (POST /transfer/v1/tokens)", () => {
  it("lleva SÓLO monto, moneda y el procesador copiado del config; con la llave pública", () => {
    const req = buildBreBTokenRequest({
      amountCents: 4_550_000,
      currency: "COP",
      processor: { name: "Bre-B Credibanco Processor", channel: "QR" },
    });
    expect(req).toEqual({
      method: "POST",
      path: "/transfer/v1/tokens",
      auth: "public",
      body: {
        amount: { subtotalIva: 0, subtotalIva0: 45500, iva: 0 },
        currency: "COP",
        processor: { name: "Bre-B Credibanco Processor", channel: "QR" },
      },
    });
    // Ni banco, ni datos del pagador, ni el selector de flujo que se supuso antes.
    expect(req.body).not.toHaveProperty("bankId");
    expect(req.body).not.toHaveProperty("flowType");
    expect(req.body).not.toHaveProperty("flow");
  });

  it("dentro de `processor` no viaja ninguna propiedad extra", () => {
    const sneaky = { name: "Bre-B Credibanco Processor", channel: "QR", extra: "x" } as never;
    const req = buildBreBTokenRequest({ amountCents: 100_00, currency: "COP", processor: sneaky });
    expect(Object.keys(req.body!.processor as object).sort()).toEqual(["channel", "name"]);
  });

  it("un monto inválido no arma petición", () => {
    const processor = { name: "P", channel: "QR" };
    expect(() => buildBreBTokenRequest({ amountCents: 0, currency: "COP", processor })).toThrow();
    expect(() => buildBreBTokenRequest({ amountCents: 1.5, currency: "COP", processor })).toThrow();
  });

  it("la respuesta trae el token; sin token, falla cerrado", () => {
    expect(parseBreBTokenResponse(TOKEN_RESPONSE)).toEqual({ token: TOKEN_RESPONSE.token });
    expect(() => parseBreBTokenResponse({})).toThrow(BreBContractError);
    expect(() => parseBreBTokenResponse({ token: "" })).toThrow(BreBContractError);
  });
});

describe("init (POST /transfer/v1/init)", () => {
  it("con la llave PRIVADA, el MISMO monto del token y nuestra metadata", () => {
    const req = buildBreBInitRequest({
      token: "tok",
      amountCents: 4_550_000,
      metadata: { chargeId: "charge-1", paymentId: "pay-1", orderId: "order-1" },
      webhookUrl: "https://mesapay.co/api/webhooks/kushki",
    });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/transfer/v1/init");
    expect(req.auth).toBe("private");
    expect(req.body).toEqual({
      token: "tok",
      amount: { subtotalIva: 0, subtotalIva0: 45500, iva: 0 },
      metadata: { kind: "bre_b", breBChargeId: "charge-1", paymentId: "pay-1", orderId: "order-1" },
      webhooks: [
        { events: ["approvedTransaction", "declinedTransaction"], urls: ["https://mesapay.co/api/webhooks/kushki"] },
      ],
    });
  });

  it("una URL de aviso que no es https no viaja", () => {
    const req = buildBreBInitRequest({
      token: "tok",
      amountCents: 100_00,
      metadata: { chargeId: "c" },
      webhookUrl: "http://localhost:3530/api/webhooks/kushki",
    });
    expect(req.body).not.toHaveProperty("webhooks");
  });

  it("la respuesta trae el QR como data:image/png;base64 y las referencias", () => {
    expect(parseBreBInitResponse(INIT_RESPONSE)).toEqual({
      qrImage: QR_DATA_URI,
      transactionReference: "ref-fake-0001",
      ticketNumber: "000000111111",
    });
  });

  it("el QR vence a los 10 minutos", () => {
    expect(BRE_B_QR_TTL_SECONDS).toBe(600);
  });

  it.each([
    ["sin qr", { ticketNumber: "1" }],
    ["qr vacío", { qr: "" }],
    ["una URL (no se pinta nada remoto)", { qr: "https://evil.example/qr.png" }],
    ["otro tipo de imagen", { qr: `data:image/svg+xml;base64,${PNG_BASE64}` }],
    ["base64 suelto sin prefijo", { qr: PNG_BASE64 }],
    ["HTML", { qr: "data:image/png;base64,<script>alert(1)</script>" }],
    ["objeto", { qr: { image: QR_DATA_URI } }],
    ["redirectUrl de PSE", { redirectUrl: "https://banco.example" }],
  ])("falla cerrado: %s", (_label, body) => {
    expect(() => parseBreBInitResponse(body)).toThrow(BreBContractError);
  });

  it("isBreBQrImage sólo acepta un PNG incrustado", () => {
    expect(isBreBQrImage(QR_DATA_URI)).toBe(true);
    expect(isBreBQrImage(`${QR_DATA_URI}"onerror="x`)).toBe(false);
    expect(isBreBQrImage(null)).toBe(false);
  });
});

describe("status (GET /transfer/v1/status/{token})", () => {
  it("con la llave privada y el token en la ruta", () => {
    expect(buildBreBStatusRequest("tok/1")).toEqual({
      method: "GET",
      path: "/transfer/v1/status/tok%2F1",
      auth: "private",
    });
  });

  it.each([
    ["approvedTransaction", "approved"],
    ["declinedTransaction", "declined"],
    ["initializedTransaction", "pending"],
  ])("%s → %s, con el monto en centavos", (raw, mapped) => {
    expect(parseBreBStatusResponse(statusResponse(raw))).toEqual({
      status: mapped,
      amountCents: 4_550_000,
      currency: null,
      token: TOKEN_RESPONSE.token,
      transactionReference: "ref-fake-0001",
      ticketNumber: "000000111111",
    });
  });

  it("un estado que no está en la referencia NO se adivina", () => {
    expect(() => parseBreBStatusResponse(statusResponse("APPROVAL"))).toThrow(BreBContractError);
    expect(() => parseBreBStatusResponse(statusResponse("approved"))).toThrow(BreBContractError);
    expect(() => parseBreBStatusResponse({ amount: { subtotalIva0: 1 } })).toThrow(BreBContractError);
    expect(() => parseBreBStatusResponse({})).toThrow(BreBContractError);
  });

  it("sin un objeto amount legible el monto queda null (no verificable)", () => {
    expect(parseBreBStatusResponse({ status: "approvedTransaction" }).amountCents).toBeNull();
    expect(parseBreBStatusResponse({ status: "approvedTransaction", amount: { subtotalIva0: "x" } }).amountCents).toBeNull();
    expect(parseBreBStatusResponse({ status: "approvedTransaction", amount: 45500 }).amountCents).toBeNull();
  });

  it("suma subtotalIva, subtotalIva0, iva y extraTaxes", () => {
    const parsed = parseBreBStatusResponse({
      status: "approvedTransaction",
      amount: { subtotalIva: 100, subtotalIva0: 45500, iva: 19, extraTaxes: { propina: 10.5 } },
    });
    expect(parsed.amountCents).toBe(4_562_950);
  });
});

describe("cancel (PATCH /transfer/v1/cancel/{token})", () => {
  it("con la llave privada y sin cuerpo", () => {
    expect(buildBreBCancelRequest("tok")).toEqual({ method: "PATCH", path: "/transfer/v1/cancel/tok", auth: "private" });
  });
});

describe("códigos de error de Kushki", () => {
  it("lee E046 / E049 / T023 del cuerpo; cualquier otra cosa es null", () => {
    expect(readKushkiErrorCode(kushkiError("E046"))).toBe("E046");
    expect(readKushkiErrorCode(kushkiError("E049"))).toBe("E049");
    expect(readKushkiErrorCode(kushkiError("T023"))).toBe("T023");
    expect(readKushkiErrorCode("<html>502</html>")).toBeNull();
    expect(readKushkiErrorCode(JSON.stringify({ code: "no es un código" }))).toBeNull();
    expect(readKushkiErrorCode(null)).toBeNull();
  });
});

describe("webhook (mismo cuerpo que el de PSE)", () => {
  it("lee estado, monto y referencias, y nuestra metadata", () => {
    const event = parseBreBWebhook(statusResponse("approvedTransaction"));
    expect(event).toMatchObject({
      status: "approved",
      amountCents: 4_550_000,
      token: TOKEN_RESPONSE.token,
      metadata: { chargeId: "charge-1", paymentId: "pay-1" },
    });
  });

  it("las referencias se leen aunque el estado no se entienda", () => {
    const refs = readBreBWebhookReferences({ token: "t", ticketNumber: 123, metadata: { breBChargeId: "c" } });
    expect(refs).toMatchObject({ token: "t", ticketNumber: "123", chargeId: "c" });
  });

  it("un aviso sin estado reconocible falla cerrado", () => {
    expect(() => parseBreBWebhook({})).toThrow(BreBContractError);
    expect(() => parseBreBWebhook({ status: "COMPLETED", amount: { subtotalIva0: 1 } })).toThrow(BreBContractError);
  });
});

describe("el contrato documentado", () => {
  it("lista lo verificado y lo pendiente, y ninguna ruta usa los supuestos viejos", () => {
    expect(BRE_B_CONTRACT_VERIFIED.length).toBeGreaterThan(0);
    expect(BRE_B_CONTRACT_PENDING.length).toBeGreaterThan(0);
    expect(BRE_B_PATHS.config).toBe("/transfer/v1/config?paymentType=PAYMENT");
    expect(JSON.stringify(BRE_B_CONTRACT_VERIFIED)).not.toMatch(/flowType/);
  });
});
