import { z } from "zod";

/**
 * ADAPTADOR DEL CONTRATO «Transfer In» DE KUSHKI PARA Bre-B (QR de pago
 * inmediato, Colombia). TODO lo que depende de cómo Kushki nombra un campo,
 * una ruta o un header vive ACÁ y sólo acá: el resto de MESAPAY (servicio,
 * rutas, pantallas) habla con los tipos normalizados que exporta este
 * archivo.
 *
 * Fuente: portal de desarrolladores de Kushki (Colombia → Online Payments →
 * Transfer in), leído el 2026-11-13. El producto es **Beta / Early
 * Release**: Kushki avisa que puede cambiar y pide coordinar con su equipo
 * de integraciones antes de producción. Por eso el medio nace apagado por
 * comercio.
 *
 * Lo que la referencia confirma (`BRE_B_CONTRACT_VERIFIED`) no lleva marca.
 * Lo que la referencia NO dice (`BRE_B_CONTRACT_PENDING`) está marcado
 * `// CONTRATO PENDIENTE DE VERIFICAR` y se confirma con Kushki / en UAT.
 *
 * Regla de oro: FALLA CERRADO. Una respuesta que no se entiende NUNCA se
 * interpreta como aprobada: los parsers lanzan `BreBContractError` y quien
 * llama deja el pago sin crear o pendiente para conciliación.
 *
 * Sin I/O: sólo arma peticiones (`BreBRequest`) y lee respuestas. Quien las
 * envía es `src/lib/payments/breB/gateway.ts`.
 */

// ── El contrato, en un solo lugar (también va al informe del PR) ──────────

export const BRE_B_CONTRACT_VERIFIED = [
  "GET /transfer/v1/config?paymentType=PAYMENT (Public-Merchant-Id) → { processors: [{ name, currency, supportedFlows? }] }; la entrada CON supportedFlows es el APM (Bre-B) y su entrada PAYMENT trae los `channels` (hoy QR).",
  "POST /transfer/v1/tokens (Public-Merchant-Id) con { amount, currency: COP, processor: { name, channel } } copiados TAL CUAL de config → 201 { token }. Token de un solo uso, 30 minutos.",
  "POST /transfer/v1/init (Private-Merchant-Id) con { token, amount (el mismo), metadata?, webhooks? } → 201 con `qr` = data:image/png;base64,… El QR vence a los 10 minutos.",
  "GET /transfer/v1/status/{token} (Private-Merchant-Id) → status ∈ initializedTransaction | approvedTransaction | declinedTransaction, con amount y token.",
  "PATCH /transfer/v1/cancel/{token} (Private-Merchant-Id) → 204 sin cuerpo; 400 T023 si ya llegó a un estado final.",
  "Errores: 422 E046 (token no compatible con el procesador), 404 E049 (el comercio no tiene llaves Bre-B en Kushki), 401 (credencial faltante o inválida), 400 E001 (paymentType inválido en config).",
  "Montos en unidades mayores (pesos) en amount { subtotalIva, subtotalIva0, iva, extraTaxes? }; sin impuestos, todo en subtotalIva0.",
  "Modo multiprocesador: si el MISMO comercio tiene PSE y Bre-B, todo token lleva `processor` (PSE: { name } sin channel).",
] as const;

export const BRE_B_CONTRACT_PENDING = [
  "El nombre exacto del procesador Bre-B del comercio (por eso se lee de config; nunca se escribe a mano).",
  "Que `metadata` del init vuelva en el webhook de Bre-B (se asume igual que PSE; si no vuelve, el aviso se casa por token / ticketNumber / transactionReference).",
  "La forma exacta del webhook (la referencia sólo dice «idéntico al de PSE») y cómo se firma: se verifica como los demás avisos de Kushki (HMAC-SHA256, header X-Kushki-Signature) con la firma del comercio Bre-B; un aviso que no pasa la firma no se aplica, pero dispara una consulta de estado.",
  "Si un QR vencido (10 min) pasa solo a declinedTransaction o se queda en initializedTransaction: MESAPAY lo cancela al vencer y cierra con el resultado real.",
  "Devoluciones / reversos de Bre-B: la referencia no documenta ninguno (en MESAPAY la devolución es manual).",
  "Comisiones y tiempos de liquidación, y a qué wallet liquida el comercio Bre-B.",
] as const;

// ── Constantes del contrato ───────────────────────────────────────────────

export const BRE_B_PATHS = {
  config: "/transfer/v1/config?paymentType=PAYMENT",
  token: "/transfer/v1/tokens",
  init: "/transfer/v1/init",
  status: (token: string) => `/transfer/v1/status/${encodeURIComponent(token)}`,
  cancel: (token: string) => `/transfer/v1/cancel/${encodeURIComponent(token)}`,
} as const;

/** El QR de Kushki vence a los 10 minutos (referencia). */
export const BRE_B_QR_TTL_SECONDS = 600;

/** Flujo de config que sirve para cobrar. */
const PAYMENT_FLOW = "PAYMENT";
/** Canal de Bre-B que MESAPAY sabe mostrar. */
const QR_CHANNEL = "QR";

/** Códigos de error de Kushki que MESAPAY reconoce. */
export const KUSHKI_TRANSFER_ERRORS = {
  /** 422 en init: el token no es compatible con el procesador resuelto. */
  processorMismatch: "E046",
  /** 404 en init: el comercio no tiene llaves de Bre-B configuradas en Kushki. */
  breBKeysMissing: "E049",
  /** 400 en cancel: la transacción ya llegó a un estado final. */
  alreadyFinal: "T023",
} as const;

const STATUS_MAP: Record<string, BreBProviderStatus> = {
  approvedTransaction: "approved",
  declinedTransaction: "declined",
  initializedTransaction: "pending",
};

// CONTRATO PENDIENTE DE VERIFICAR: headers del webhook (los de los demás
// avisos de Kushki; la referencia de Bre-B no los detalla).
export const BRE_B_WEBHOOK_HEADERS = {
  signature: ["x-kushki-signature", "kushki-signature"],
  id: "x-kushki-id",
  merchantKey: "x-kushki-key",
} as const;

// ── Tipos normalizados (lo único que ve el resto de MESAPAY) ──────────────

export type BreBCurrency = "COP";

/** Qué llave autentica la petición. */
export type BreBAuth = "public" | "private";

export type BreBRequest = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  auth: BreBAuth;
  body?: Record<string, unknown>;
};

/** El procesador tal como lo nombra config: va TAL CUAL en el token. */
export type TransferProcessor = { name: string; channel?: string };

export type TransferConfig = {
  /** Procesadores de transferencia del comercio (PSE, Bre-B…). */
  processors: Array<{
    name: string;
    currency: string | null;
    /** Sólo los APM (Bre-B) traen flujos; PSE no. */
    flows: Array<{ paymentType: string; channels: string[] }> | null;
  }>;
};

export type BreBProviderStatus = "approved" | "declined" | "pending";

export type BreBInitResult = {
  /** Imagen del QR: SIEMPRE `data:image/png;base64,…`, ya validada. */
  qrImage: string;
  transactionReference: string | null;
  ticketNumber: string | null;
};

export type BreBStatusResult = {
  status: BreBProviderStatus;
  /** Monto en CENTAVOS; null = la respuesta no lo trae (no verificable). */
  amountCents: number | null;
  currency: string | null;
  token: string | null;
  transactionReference: string | null;
  ticketNumber: string | null;
};

export type BreBWebhookEvent = BreBStatusResult & {
  /** Lo que MESAPAY mandó en `metadata` al iniciar el cobro. */
  metadata: {
    chargeId: string | null;
    paymentId: string | null;
    orderId: string | null;
    paymentLinkId: string | null;
  };
  merchantId: string | null;
};

/** La respuesta de Kushki no tiene la forma esperada. Nunca es "aprobado". */
export class BreBContractError extends Error {
  constructor(
    public readonly step: "config" | "token" | "init" | "status" | "webhook",
    public readonly reason: string,
  ) {
    super(`bre_b_contract_${step}:${reason}`);
    this.name = "BreBContractError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Montos de Kushki: unidades mayores (pesos) → centavos, sin perder precisión. */
function toCents(major: number): number | null {
  if (!Number.isFinite(major) || major < 0) return null;
  const cents = Math.round(major * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Centavos → el objeto `amount` de «Transfer In» (sin impuestos discriminados). */
function amountBody(amountCents: number): { subtotalIva: number; subtotalIva0: number; iva: number } {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new Error("bre_b_invalid_amount");
  return { subtotalIva: 0, subtotalIva0: amountCents / 100, iva: 0 };
}

/**
 * Monto del objeto `amount` de Kushki: suma de sus partes (incluidos los
 * `extraTaxes`, si vinieran). Sin un `amount` legible → null (no verificable).
 */
function readAmountCents(source: Record<string, unknown>): number | null {
  const parts = obj(source.amount);
  if (typeof parts.subtotalIva0 !== "number" && typeof parts.subtotalIva !== "number") return null;
  let total = 0;
  for (const key of ["subtotalIva", "subtotalIva0", "iva"]) {
    const value = parts[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  for (const value of Object.values(obj(parts.extraTaxes))) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return toCents(total);
}

function readCurrency(source: Record<string, unknown>): string | null {
  const direct = str(source.currency) ?? str(obj(source.amount).currency);
  return direct && /^[A-Za-z]{3}$/.test(direct) ? direct.toUpperCase() : null;
}

function readStatus(source: Record<string, unknown>, step: "status" | "webhook"): BreBProviderStatus {
  const raw = str(source.status);
  if (!raw) throw new BreBContractError(step, "missing_status");
  const mapped = STATUS_MAP[raw];
  // Un estado que no está en la referencia NO se adivina: ni aprobado ni rechazado.
  if (!mapped) throw new BreBContractError(step, "unknown_status");
  return mapped;
}

/**
 * El código de error de Kushki (`E046`, `T023`…) a partir del cuerpo de una
 * respuesta 4xx. null si el cuerpo no es el JSON de error de Kushki.
 */
export function readKushkiErrorCode(body: string | null | undefined): string | null {
  if (!body) return null;
  try {
    const code = obj(JSON.parse(body)).code;
    return typeof code === "string" && /^[A-Z]{1,4}\d{2,4}$/.test(code.trim()) ? code.trim() : null;
  } catch {
    return null;
  }
}

// ── Config: qué procesadores tiene el comercio ────────────────────────────

/** Config del comercio. Con la llave PÚBLICA. Es el punto de partida obligatorio. */
export function buildTransferConfigRequest(): BreBRequest {
  return { method: "GET", path: BRE_B_PATHS.config, auth: "public" };
}

const ConfigResponseSchema = z
  .object({
    processors: z.array(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          currency: z.string().optional().nullable(),
          supportedFlows: z
            .array(
              z
                .object({
                  paymentType: z.string(),
                  channels: z.array(z.string()).default([]),
                })
                .passthrough(),
            )
            .optional()
            .nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export function parseTransferConfigResponse(json: unknown): TransferConfig {
  const parsed = ConfigResponseSchema.safeParse(json);
  if (!parsed.success) throw new BreBContractError("config", "unexpected_shape");
  return {
    processors: parsed.data.processors.map((p) => ({
      name: p.name,
      currency: p.currency ?? null,
      flows: p.supportedFlows ? p.supportedFlows.map((f) => ({ paymentType: f.paymentType, channels: f.channels })) : null,
    })),
  };
}

/**
 * El procesador con el que se pide un token Bre-B, o null si el comercio no
 * tiene Bre-B habilitado (lo activa el ejecutivo de cuenta de Kushki): un
 * APM (entrada con flujos) con un flujo `PAYMENT` por el canal `QR`. El
 * nombre y el canal se devuelven TAL CUAL vienen: así van en el token.
 *
 * CONTRATO PENDIENTE DE VERIFICAR: el nombre del procesador. No se compara
 * contra ningún texto fijo; si hubiera más de un APM con QR, se prefiere el
 * que se llame Bre-B y, si ninguno, no se elige a ciegas.
 */
export function selectBreBProcessor(config: TransferConfig): Required<TransferProcessor> | null {
  const candidates = config.processors.flatMap((p) => {
    const flow = p.flows?.find((f) => f.paymentType === PAYMENT_FLOW && f.channels.includes(QR_CHANNEL));
    return flow ? [{ name: p.name, channel: QR_CHANNEL }] : [];
  });
  if (candidates.length === 1) return candidates[0];
  const named = candidates.filter((c) => /bre[\s-]?b/i.test(c.name));
  return named.length === 1 ? named[0] : null;
}

/**
 * Modo multiprocesador: con más de un procesador de transferencia en el
 * MISMO comercio, TODO token lleva `processor`, también el de PSE (sólo
 * `name`, sin `channel`). Con uno solo, el token de PSE va sin `processor`,
 * como siempre: por eso devuelve null.
 */
export function selectPseProcessor(config: TransferConfig): TransferProcessor | null {
  if (config.processors.length <= 1) return null;
  // PSE es el procesador tradicional: la entrada SIN flujos.
  const traditional = config.processors.filter((p) => !p.flows);
  return traditional.length === 1 ? { name: traditional[0].name } : null;
}

// ── Peticiones ────────────────────────────────────────────────────────────

/**
 * Paso 1: token de «Transfer In» para el procesador Bre-B. Con `processor`
 * sólo son obligatorios el monto y la moneda; no lleva banco ni datos del
 * pagador (paga quien escanee el QR). Dentro de `processor` no se admite
 * ninguna propiedad extra.
 */
export function buildBreBTokenRequest(input: {
  amountCents: number;
  currency: BreBCurrency;
  processor: Required<TransferProcessor>;
  description?: string;
}): BreBRequest {
  return {
    method: "POST",
    path: BRE_B_PATHS.token,
    auth: "public",
    body: {
      amount: amountBody(input.amountCents),
      currency: input.currency,
      processor: { name: input.processor.name, channel: input.processor.channel },
      ...(input.description ? { paymentDescription: input.description.slice(0, 120) } : {}),
    },
  };
}

/**
 * Paso 2: init con el token y EL MISMO monto. Devuelve el QR.
 * `metadata` es nuestra (con ella se casa el aviso con el cobro) y
 * `webhooks` suma nuestra URL a las de la Consola del comercio.
 */
export function buildBreBInitRequest(input: {
  token: string;
  amountCents: number;
  metadata: { chargeId: string; paymentId?: string; orderId?: string; paymentLinkId?: string };
  /** URL https de `/api/webhooks/kushki`; se omite si no es https. */
  webhookUrl?: string | null;
}): BreBRequest {
  const webhookUrl = input.webhookUrl && /^https:\/\//.test(input.webhookUrl) ? input.webhookUrl : null;
  return {
    method: "POST",
    path: BRE_B_PATHS.init,
    auth: "private",
    body: {
      token: input.token,
      amount: amountBody(input.amountCents),
      metadata: {
        kind: "bre_b",
        breBChargeId: input.metadata.chargeId,
        ...(input.metadata.paymentId ? { paymentId: input.metadata.paymentId } : {}),
        ...(input.metadata.orderId ? { orderId: input.metadata.orderId } : {}),
        ...(input.metadata.paymentLinkId ? { paymentLinkId: input.metadata.paymentLinkId } : {}),
      },
      ...(webhookUrl
        ? { webhooks: [{ events: ["approvedTransaction", "declinedTransaction"], urls: [webhookUrl] }] }
        : {}),
    },
  };
}

export function buildBreBStatusRequest(token: string): BreBRequest {
  return { method: "GET", path: BRE_B_PATHS.status(token), auth: "private" };
}

/** Sólo Bre-B: cancela una transacción activa e invalida el QR. 204 sin cuerpo. */
export function buildBreBCancelRequest(token: string): BreBRequest {
  return { method: "PATCH", path: BRE_B_PATHS.cancel(token), auth: "private" };
}

// ── Respuestas ────────────────────────────────────────────────────────────

const TokenResponseSchema = z.object({ token: z.string().trim().min(1).max(500) }).passthrough();

export function parseBreBTokenResponse(json: unknown): { token: string } {
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) throw new BreBContractError("token", "missing_token");
  return { token: parsed.data.token };
}

/** Lo ÚNICO que se pinta como QR: un PNG incrustado. Nunca una URL ni HTML. */
const QR_DATA_URI = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
/** Un QR en PNG pesa unos pocos KB; más que esto no es un QR. */
const QR_MAX_LENGTH = 500_000;

export function isBreBQrImage(value: unknown): value is string {
  return typeof value === "string" && value.length <= QR_MAX_LENGTH && QR_DATA_URI.test(value);
}

const InitResponseSchema = z
  .object({
    qr: z.string(),
    transactionReference: z.union([z.string(), z.number()]).optional().nullable(),
    ticketNumber: z.union([z.string(), z.number()]).optional().nullable(),
  })
  .passthrough();

/**
 * Init de Bre-B: `qr` es el Data URI completo `data:image/png;base64,…`. Se
 * valida ese prefijo (y que sea base64) ANTES de aceptarlo: cualquier otra
 * cosa —una URL, otro tipo de imagen, vacío— falla y no se pinta nada.
 */
export function parseBreBInitResponse(json: unknown): BreBInitResult {
  const parsed = InitResponseSchema.safeParse(json);
  if (!parsed.success) throw new BreBContractError("init", "missing_qr");
  const qr = parsed.data.qr.trim();
  if (!isBreBQrImage(qr)) throw new BreBContractError("init", "qr_not_png_data_uri");
  return {
    qrImage: qr,
    transactionReference: str(parsed.data.transactionReference),
    ticketNumber: str(parsed.data.ticketNumber),
  };
}

export function parseBreBStatusResponse(json: unknown): BreBStatusResult {
  const root = obj(json);
  if (Object.keys(root).length === 0) throw new BreBContractError("status", "empty_response");
  return {
    status: readStatus(root, "status"),
    amountCents: readAmountCents(root),
    currency: readCurrency(root),
    token: str(root.token),
    transactionReference: str(root.transactionReference),
    ticketNumber: str(root.ticketNumber),
  };
}

// ── Webhook ───────────────────────────────────────────────────────────────

/**
 * Referencias con las que un aviso de Kushki puede casar con un cobro
 * Bre-B. No valida nada: sólo extrae, para buscar el `BreBCharge`.
 *
 * CONTRATO PENDIENTE DE VERIFICAR: que `metadata` vuelva en el aviso (se
 * asume igual que PSE). Si no vuelve, casa por token / ticket / referencia.
 */
export function readBreBWebhookReferences(body: unknown): {
  chargeId: string | null;
  paymentId: string | null;
  orderId: string | null;
  paymentLinkId: string | null;
  token: string | null;
  transactionReference: string | null;
  ticketNumber: string | null;
  merchantId: string | null;
} {
  const root = obj(body);
  const meta = obj(root.metadata);
  return {
    chargeId: str(meta.breBChargeId),
    paymentId: str(meta.paymentId),
    orderId: str(meta.orderId),
    paymentLinkId: str(meta.paymentLinkId),
    token: str(root.token),
    transactionReference: str(root.transactionReference),
    ticketNumber: str(root.ticketNumber),
    merchantId: str(root.publicMerchantId) ?? str(root.merchantId),
  };
}

/**
 * Lee el aviso completo (estado + monto), con la misma forma del status.
 * Lanza `BreBContractError` si el estado falta o no es uno de los tres de
 * la referencia: quien llama NO aplica nada y consulta el estado.
 */
export function parseBreBWebhook(body: unknown): BreBWebhookEvent {
  const root = obj(body);
  if (Object.keys(root).length === 0) throw new BreBContractError("webhook", "empty_body");
  const refs = readBreBWebhookReferences(body);
  return {
    status: readStatus(root, "webhook"),
    amountCents: readAmountCents(root),
    currency: readCurrency(root),
    token: refs.token,
    transactionReference: refs.transactionReference,
    ticketNumber: refs.ticketNumber,
    metadata: {
      chargeId: refs.chargeId,
      paymentId: refs.paymentId,
      orderId: refs.orderId,
      paymentLinkId: refs.paymentLinkId,
    },
    merchantId: refs.merchantId,
  };
}

/** Llave pública del comercio que manda el aviso (header), si viene. */
export function readBreBWebhookMerchantKey(headers: Headers): string | null {
  return str(headers.get(BRE_B_WEBHOOK_HEADERS.merchantKey));
}
