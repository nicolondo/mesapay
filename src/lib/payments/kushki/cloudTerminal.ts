import { createHmac, randomUUID } from "crypto";
import { env } from "../../env";
import { getKushkiMode } from "../../platformConfig";

/**
 * Cliente del Kushki ONE — Payment API (Cloud) para datáfonos SmartPOS
 * (Sunmi P3/P2). Host cloudt.kushkipagos.com (prod) / uat-cloudt (UAT).
 *
 * AUTENTICACIÓN (OpenAPI oficial "Kushki ONE — Payment API (Cloud)"):
 *   Authorization = Base64( HMAC-SHA256( rawBody, Business-Code ) )
 *   timestamp     = Unix en MILISEGUNDOS (±5 min del server)
 *   El Business-Code es la clave HMAC; lo carga el comercio en
 *   Configuración → Datáfonos.
 *
 * Cobro SÍNCRONO: POST /terminal/v1/{serial}/sync/charge bloquea hasta que
 * el cliente pasa la tarjeta y el adquirente responde. El resultado vuelve
 * en la misma respuesta (no hay webhook).
 *
 * ⚠️ El equipo debe estar online (egress 443) y con la app Kushki ONE
 * Connect activa para recibir el push; si no, la nube responde
 * CLOUDPAYMENT_VALIDATION_ERROR antes de validar la firma.
 */

const BASE_URL = {
  sandbox: "https://uat-cloudt.kushkipagos.com",
  production: "https://cloudt.kushkipagos.com",
} as const;

// async: lee el modo de la DB (warmea cache). Evita el default "mock".
async function baseUrl(): Promise<string> {
  if (env.KUSHKI_CLOUD_TERMINAL_URL) return env.KUSHKI_CLOUD_TERMINAL_URL;
  const mode = await getKushkiMode();
  if (mode === "mock") {
    throw new Error("cloudTerminal must not be called in mock mode");
  }
  return BASE_URL[mode];
}

/** El serial va en el path: POST /terminal/v1/{serial}/sync/charge. */
function pushPath(serial: string): string {
  const tmpl =
    env.KUSHKI_CLOUD_TERMINAL_PATH || "/terminal/v1/{serial}/sync/charge";
  return tmpl.replace("{serial}", encodeURIComponent(serial));
}

// El cobro es síncrono: la doc sugiere timeout ≥90s por la latencia del relay.
const CHARGE_TIMEOUT_MS = 95_000;

/** Business-Code = clave HMAC. Sin él no podemos firmar → no cobrar. */
function resolveBusinessCode(explicit?: string | null): string {
  const code = explicit || env.KUSHKI_BP_BUSINESS_CODE;
  if (!code) {
    throw new Error(
      "Cloud Terminal sin Business-Code (clave HMAC). Cargalo en " +
        "Configuración → Datáfonos.",
    );
  }
  return code;
}

/** Authorization = Base64( HMAC-SHA256( rawBody, businessCode ) ). */
function signBody(rawBody: string, businessCode: string): string {
  return createHmac("sha256", businessCode)
    .update(rawBody, "utf8")
    .digest("base64");
}

export type CloudTerminalPushArgs = {
  /** Serial del equipo (TerminalDevice.serialNumber). Va en el path. */
  serialNumber: string;
  /** Monto TOTAL a cobrar en centavos (ya incluye propina). */
  amountCents: number;
  /** Referencia nuestra (Payment.id) → metadata.reference. */
  reference: string;
  /** Texto opcional. */
  description?: string;
  /** Email del cliente (opcional) → metadata.customer_email. */
  customerEmail?: string | null;
  /** Business-Code del comercio (clave HMAC). Fallback al env. */
  businessCode?: string | null;
};

export type CloudTerminalChargeResult = {
  /** Estado FINAL del cobro síncrono. */
  status: "approved" | "declined" | "error";
  /** transaction_reference (para void/refund) o el client_transaction_id. */
  providerRef: string;
  message?: string;
  httpStatus?: number;
  raw?: unknown;
};

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}
function pick(obj: unknown, keys: string[]): string | undefined {
  const o = asObj(obj);
  if (!o) return undefined;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/**
 * Cobra SÍNCRONO en el datáfono. Devuelve el resultado final (aprobado /
 * rechazado / error); el caller settlea con eso.
 */
export async function pushPaymentToCloudTerminal(
  args: CloudTerminalPushArgs,
): Promise<CloudTerminalChargeResult> {
  const businessCode = resolveBusinessCode(args.businessCode);
  // COP no tiene decimales → unidades mayores (pesos enteros).
  const amount = Math.round(args.amountCents / 100);
  const clientTxnId = randomUUID(); // idempotency key (UUID v4)
  const payload = {
    amount: {
      iva: 0,
      subtotal_iva: 0,
      subtotal_iva0: amount,
      extra_taxes: { airport_tax: 0, iac: 0, ice: 0, travel_agency: 0 },
    },
    client_transaction_id: clientTxnId,
    metadata: {
      reference: args.reference,
      ...(args.customerEmail ? { customer_email: args.customerEmail } : {}),
      device: "MESAPAY",
    },
  };

  // Firmamos y enviamos EXACTAMENTE este string (byte-idéntico al firmado).
  const raw = JSON.stringify(payload);
  const authorization = signBody(raw, businessCode);
  const ts = Date.now().toString(); // MILISEGUNDOS
  const url = (await baseUrl()) + pushPath(args.serialNumber);

  console.log("[kushki/cloud-terminal] charge", {
    url,
    serialNumber: args.serialNumber,
    amount,
    reference: args.reference,
    clientTxnId,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHARGE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: authorization,
        timestamp: ts,
      },
      body: raw,
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err instanceof Error && err.name === "AbortError";
    console.error(
      `[kushki/cloud-terminal] charge ${aborted ? "timeout" : "network error"}`,
      err,
    );
    return {
      status: "error",
      providerRef: clientTxnId,
      message: aborted ? "timeout" : "network_error",
    };
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  console.log(
    `[kushki/cloud-terminal] charge resp ${res.status}:`,
    text.slice(0, 500) || "(empty)",
  );

  const rawResp = asObj(asObj(json)?.rawResponse);
  const providerRef =
    pick(rawResp, ["transaction_reference"]) ||
    pick(json, ["transaction_reference", "client_transaction_id"]) ||
    clientTxnId;

  // ---- Errores operacionales: { type, code, message } (a veces en failure)
  if (!res.ok) {
    const failure =
      asObj(json) && "failure" in (json as object)
        ? (json as { failure: unknown }).failure
        : json;
    const type = pick(failure, ["type"]);
    const code = pick(failure, ["code"]);
    const msg = pick(failure, ["message"]);
    const label =
      [type, code].filter(Boolean).join("/") +
      (msg ? `${type || code ? ": " : ""}${msg}` : "");
    return {
      status: "error",
      providerRef,
      message: label || `http_${res.status}`,
      httpStatus: res.status,
      raw: json,
    };
  }

  // ---- 200: leer transaction_status (APPROVAL / DECLINED / ERROR) + approved
  const txStatus = pick(rawResp, ["transaction_status"])?.toUpperCase();
  const approvedFlag = asObj(json)?.approved;
  const message =
    pick(json, ["message"]) || pick(asObj(rawResp)?.kushki_response, ["message"]);

  if (txStatus === "DECLINED" || approvedFlag === false) {
    return {
      status: "declined",
      providerRef,
      message: message || "declined",
      httpStatus: res.status,
      raw: json,
    };
  }
  if (txStatus === "ERROR") {
    return {
      status: "error",
      providerRef,
      message: message || "terminal_error",
      httpStatus: res.status,
      raw: json,
    };
  }
  // APPROVAL (o approved:true / sin status explícito en 200) → aprobado.
  return {
    status: "approved",
    providerRef,
    message,
    httpStatus: res.status,
    raw: json,
  };
}

/**
 * Aborta un cobro en curso en el datáfono (POST /sync/abort, sin body ni
 * Authorization). Best-effort: si no hay transacción activa, Kushki da 409.
 */
export async function cancelCloudTerminalPayment(
  serialNumber: string,
  _reference: string,
  _businessCode?: string | null,
): Promise<void> {
  if (!serialNumber) return;
  try {
    const url =
      (await baseUrl()) +
      `/terminal/v1/${encodeURIComponent(serialNumber)}/sync/abort`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`[kushki/cloud-terminal] abort ${res.status} (best-effort)`);
    }
  } catch (err) {
    console.warn("[kushki/cloud-terminal] abort error (best-effort)", err);
  }
}
