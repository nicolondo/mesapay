import "server-only";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import type { KushkiMode } from "@/lib/platformConfig";
import { kushkiFetch, KushkiHttpError } from "../kushki/client";
import {
  BreBContractError,
  KUSHKI_TRANSFER_ERRORS,
  buildBreBCancelRequest,
  buildBreBInitRequest,
  buildBreBStatusRequest,
  buildBreBTokenRequest,
  parseBreBInitResponse,
  parseBreBStatusResponse,
  parseBreBTokenResponse,
  readKushkiErrorCode,
  selectBreBProcessor,
  type BreBCurrency,
  type BreBInitResult,
  type BreBRequest,
  type BreBStatusResult,
  type TransferProcessor,
} from "../kushki/breB";
import { getTransferConfig, invalidateTransferConfig } from "../kushki/transferConfig";
import type { BreBCredentials } from "./credentials";

/**
 * Quien HABLA con Kushki por Bre-B. El contrato (rutas, campos) está en
 * `../kushki/breB.ts`; acá sólo se envía lo que ese adaptador arma y se lee
 * con sus parsers. En modo mock no sale ninguna petición.
 */

export type BreBInitMetadata = { chargeId: string; paymentId?: string; orderId?: string; paymentLinkId?: string };
export type BreBProcessor = Required<TransferProcessor>;

export interface BreBGateway {
  /**
   * El procesador Bre-B del comercio según su config en Kushki, o null si
   * Kushki todavía no se lo habilitó. `fresh` salta la caché.
   */
  processor(opts?: { fresh?: boolean }): Promise<BreBProcessor | null>;
  requestToken(input: {
    amountCents: number;
    currency: BreBCurrency;
    processor: BreBProcessor;
    description?: string;
  }): Promise<{ token: string }>;
  init(input: {
    token: string;
    amountCents: number;
    metadata: BreBInitMetadata;
    webhookUrl?: string | null;
  }): Promise<BreBInitResult>;
  status(token: string): Promise<BreBStatusResult>;
  /** Resuelve sólo si Kushki confirmó la cancelación (204). */
  cancel(token: string): Promise<void>;
  /** Olvida la config en caché (un E046 dice que ya no es la que era). */
  forgetProcessor(): void;
}

/**
 * Qué se sabe después de un fallo:
 *   rejected    — Kushki contestó que no (4xx): definitivo, no pasó nada.
 *   unparseable — contestó 2xx pero no se entiende (contrato): NO se asume nada.
 *   unknown     — sin respuesta (red, timeout, 5xx): pudo haber pasado.
 */
export type BreBFailureKind = "rejected" | "unparseable" | "unknown";

export function breBFailureKind(err: unknown): BreBFailureKind {
  if (err instanceof BreBContractError) return "unparseable";
  if (err instanceof KushkiHttpError && err.status >= 400 && err.status < 500) return "rejected";
  return "unknown";
}

/** Código de error de Kushki (E046, E049, T023…) de un rechazo, o null. */
export function breBErrorCode(err: unknown): string | null {
  return err instanceof KushkiHttpError ? readKushkiErrorCode(err.body) : null;
}

/** El cancel dijo 400 T023: la transacción ya llegó a un estado final. */
export function isBreBAlreadyFinal(err: unknown): boolean {
  return (
    err instanceof KushkiHttpError &&
    err.status === 400 &&
    breBErrorCode(err) === KUSHKI_TRANSFER_ERRORS.alreadyFinal
  );
}

/**
 * Por qué no se pudo crear el QR, como código que las pantallas traducen:
 *
 *   bre_b_credentials_invalid   — 401: las llaves del comercio Bre-B no sirven.
 *   bre_b_processor_mismatch    — 422 E046: el token no es del procesador.
 *   bre_b_keys_missing          — 404 E049: Kushki no le configuró llaves Bre-B.
 *   bre_b_rejected              — otro 4xx: Kushki no aceptó la petición.
 *   bre_b_unavailable           — sin respuesta, o una que no se entiende.
 */
export type BreBStartError =
  | "bre_b_credentials_invalid"
  | "bre_b_processor_mismatch"
  | "bre_b_keys_missing"
  | "bre_b_processor_unavailable"
  | "bre_b_rejected"
  | "bre_b_unavailable";

export function breBStartError(err: unknown): BreBStartError {
  if (!(err instanceof KushkiHttpError) || err.status < 400 || err.status >= 500) return "bre_b_unavailable";
  if (err.status === 401) return "bre_b_credentials_invalid";
  const code = breBErrorCode(err);
  if (code === KUSHKI_TRANSFER_ERRORS.processorMismatch) return "bre_b_processor_mismatch";
  if (code === KUSHKI_TRANSFER_ERRORS.breBKeysMissing) return "bre_b_keys_missing";
  return "bre_b_rejected";
}

/** Para los logs: nunca el cuerpo (puede traer datos del pagador), sólo qué falló. */
export function breBFailureLabel(err: unknown): string {
  if (err instanceof BreBContractError) return err.message;
  if (err instanceof KushkiHttpError) return `http_${err.status}${breBErrorCode(err) ? `_${breBErrorCode(err)}` : ""}`;
  return err instanceof Error ? err.name : "unknown_error";
}

class LiveBreBGateway implements BreBGateway {
  constructor(
    private readonly mode: Exclude<KushkiMode, "mock">,
    private readonly creds: BreBCredentials,
  ) {}

  private send(request: BreBRequest): Promise<unknown> {
    return kushkiFetch<unknown>(request.path, {
      method: request.method,
      auth:
        request.auth === "public"
          ? { kind: "submerchant_public", publicKey: this.creds.publicKey }
          : { kind: "submerchant", privateKey: this.creds.privateKey },
      mode: this.mode,
      body: request.body,
      // Un token y un init no se repiten solos (cada intento crea otro QR);
      // la consulta de estado sí tolera un reintento.
      retries: request.method === "GET" ? 1 : 0,
    });
  }

  async processor(opts: { fresh?: boolean } = {}) {
    return selectBreBProcessor(await getTransferConfig(this.mode, this.creds.publicKey, opts));
  }

  forgetProcessor() {
    invalidateTransferConfig(this.mode, this.creds.publicKey);
  }

  async requestToken(input: { amountCents: number; currency: BreBCurrency; processor: BreBProcessor; description?: string }) {
    return parseBreBTokenResponse(await this.send(buildBreBTokenRequest(input)));
  }

  async init(input: { token: string; amountCents: number; metadata: BreBInitMetadata; webhookUrl?: string | null }) {
    return parseBreBInitResponse(await this.send(buildBreBInitRequest(input)));
  }

  async status(token: string) {
    return parseBreBStatusResponse(await this.send(buildBreBStatusRequest(token)));
  }

  async cancel(token: string) {
    // 204 sin cuerpo = cancelado. Cualquier no-2xx lanza KushkiHttpError
    // (400 T023 = ya estaba en un estado final: ver `isBreBAlreadyFinal`).
    await this.send(buildBreBCancelRequest(token));
  }
}

/** Prefijo de las referencias simuladas (los reportes de wallet las ignoran). */
export const MOCK_BRE_B_PREFIX = "mock_breb_";

/**
 * Modo demo: un QR de mentira (un PNG real, como el de Kushki, pero con un
 * texto que ningún banco reconoce), que nunca se paga solo. El resultado lo
 * pone la página `/t/bre-b-mock` ("aprobar" / "rechazar"), que pasa por el
 * mismo camino de verificación que un aviso real.
 */
class MockBreBGateway implements BreBGateway {
  async processor(): Promise<BreBProcessor> {
    return { name: "Mock Bre-B Processor", channel: "QR" };
  }
  forgetProcessor() {}
  async requestToken() {
    return { token: `${MOCK_BRE_B_PREFIX}${randomUUID()}` };
  }
  async init(input: { token: string; amountCents: number; metadata: BreBInitMetadata }): Promise<BreBInitResult> {
    return {
      qrImage: await QRCode.toDataURL(
        `MESAPAY-DEMO-BREB|${input.metadata.chargeId}|${(input.amountCents / 100).toFixed(2)}|COP`,
        { type: "image/png", errorCorrectionLevel: "M", margin: 2, width: 640 },
      ),
      transactionReference: null,
      ticketNumber: null,
    };
  }
  async status(token: string): Promise<BreBStatusResult> {
    return { status: "pending", amountCents: null, currency: null, token, transactionReference: null, ticketNumber: null };
  }
  async cancel() {}
}

const mock = new MockBreBGateway();

export function breBGatewayFor(mode: KushkiMode, creds: BreBCredentials | null): BreBGateway {
  if (mode === "mock") {
    if (process.env.NODE_ENV === "production") throw new Error("mock_payments_disabled");
    return mock;
  }
  if (!creds) throw new Error("bre_b_not_configured");
  return new LiveBreBGateway(mode, creds);
}
