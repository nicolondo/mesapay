/**
 * Respuestas de Kushki «Transfer In» para Bre-B, con la forma de la
 * referencia (Colombia → Online Payments → Transfer in, leída 2026-11-13).
 * Valores inventados: ninguna llave, token ni referencia es real.
 *
 * Si Kushki cambia el contrato (es Beta), se corrige
 * `../breB.ts` y estos fixtures; los tests dicen qué dejó de cuadrar.
 */

/** PNG 1×1 en base64: la forma de `qr` que entrega el init. */
export const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
export const QR_DATA_URI = `data:image/png;base64,${PNG_BASE64}`;

/** config?paymentType=PAYMENT de un comercio SÓLO Bre-B (el caso de MESAPAY: otro MID). */
export const CONFIG_BRE_B_ONLY = {
  processors: [
    {
      name: "Bre-B Credibanco Processor",
      currency: "COP",
      supportedFlows: [
        { name: "Bre-B Payment", description: "Pago con QR", paymentType: "PAYMENT", channels: ["QR"] },
      ],
    },
  ],
};

/** Comercio con PSE como único procesador: el de siempre. */
export const CONFIG_PSE_ONLY = { processors: [{ name: "Pse Processor", currency: "COP" }] };

/** Modo multiprocesador: PSE y Bre-B en el MISMO comercio. */
export const CONFIG_MULTI = {
  processors: [
    { name: "Pse Processor", currency: "COP" },
    ...CONFIG_BRE_B_ONLY.processors,
  ],
};

/** Sin procesadores configurados: 200 con lista vacía. */
export const CONFIG_EMPTY = { processors: [] };

/** Un APM sin flujo de cobro por QR (no sirve para Bre-B por QR). */
export const CONFIG_APM_WITHOUT_QR = {
  processors: [
    {
      name: "Bre-B Credibanco Processor",
      currency: "COP",
      supportedFlows: [{ name: "Bre-B Payout", description: "", paymentType: "PAYOUT", channels: ["KEY"] }],
    },
  ],
};

export const TOKEN_RESPONSE = { token: "tok_fake_0123456789abcdef" };

export const INIT_RESPONSE = {
  qr: QR_DATA_URI,
  ticketNumber: "000000111111",
  transactionReference: "ref-fake-0001",
  status: "initializedTransaction",
  amount: { subtotalIva: 0, subtotalIva0: 45500, iva: 0 },
  created: 1763050000000,
  merchantId: "fake-merchant",
};

export const statusResponse = (status: string, pesos = 45500, extra: Record<string, unknown> = {}) => ({
  status,
  processorState: status === "approvedTransaction" ? "OK" : status === "declinedTransaction" ? "NOT_AUTHORIZED" : "PENDING",
  responseCode: "000",
  ticketNumber: "000000111111",
  transactionReference: "ref-fake-0001",
  token: TOKEN_RESPONSE.token,
  amount: { subtotalIva: 0, subtotalIva0: pesos, iva: 0 },
  metadata: { breBChargeId: "charge-1", paymentId: "pay-1" },
  created: 1763050000000,
  ...extra,
});

/** Cuerpo de error de Kushki (4xx). */
export const kushkiError = (code: string, message = "error") => JSON.stringify({ code, message });
