import { createHmac } from "crypto";
import { env } from "../../env";
import { getKushkiModeSync } from "../../platformConfig";

/**
 * Cliente del Kushki **Cloud Terminal API** de Colombia (datáfono físico
 * vía cloud, host cloudt.kushkipagos.com).
 *
 * AUTENTICACIÓN (confirmada con la doc del comercio — "mismo esquema
 * HMAC-SHA256 que Local mode"):
 *   - Header `Authorization` = base64( HMAC_SHA256( key = Business-Code,
 *     msg = body crudo exacto que se envía ) ).
 *   - Header `timestamp` = Unix en MILISEGUNDOS.
 *   El Business-Code es la CLAVE del HMAC (no va en el body). Lo carga el
 *   comercio en Configuración → Datáfonos (Restaurant.cloudTerminalBusinessCode).
 *
 * ⚠️ IMPORTANTE: el body que se firma debe ser byte-idéntico al que se
 * manda. Por eso serializamos UNA sola vez (`raw`) y firmamos/enviamos ese
 * mismo string.
 *
 * Flujo: POST al endpoint del terminal → ACK; el resultado (aprobada/
 * rechazada) llega por webhook a /api/webhooks/kushki-terminal.
 */

// Hosts del Cloud Terminal CO. Override con KUSHKI_CLOUD_TERMINAL_URL.
const BASE_URL = {
  sandbox: "https://uat-cloudt.kushkipagos.com",
  production: "https://cloudt.kushkipagos.com",
} as const;

function baseUrl(): string {
  if (env.KUSHKI_CLOUD_TERMINAL_URL) return env.KUSHKI_CLOUD_TERMINAL_URL;
  const mode = getKushkiModeSync();
  if (mode === "mock") {
    throw new Error("cloudTerminal must not be called in mock mode");
  }
  return BASE_URL[mode];
}

/**
 * Path del endpoint de cobro SÍNCRONO. El serial del datáfono va en el path.
 * Confirmado por la doc del comercio: POST /terminal/v1/{serial}/sync/charge.
 * Override con KUSHKI_CLOUD_TERMINAL_PATH (placeholder {serial}) por si cambia.
 */
function pushPath(serial: string): string {
  const tmpl = env.KUSHKI_CLOUD_TERMINAL_PATH || "/terminal/v1/{serial}/sync/charge";
  return tmpl.replace("{serial}", encodeURIComponent(serial));
}

// El cobro es síncrono: la request se queda esperando mientras el cliente
// pasa la tarjeta. Damos margen (la doc sugiere ~90s por la latencia del relay).
const CHARGE_TIMEOUT_MS = 95_000;

/** Business-Code = clave del HMAC. Sin él no podemos firmar → no cobrar. */
function resolveBusinessCode(explicit?: string | null): string {
  const code = explicit || env.KUSHKI_BP_BUSINESS_CODE;
  if (!code) {
    throw new Error(
      "Cloud Terminal sin Business-Code (es la clave HMAC). Cargalo en " +
        "Configuración → Datáfonos.",
    );
  }
  return code;
}

/** Authorization = base64(HMAC-SHA256(key=businessCode, msg=rawBody)). */
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
  /**
   * Referencia única nuestra (= Payment.id). La mandamos como
   * client_transaction_id y la usamos para matchear el webhook.
   */
  reference: string;
  /** Texto opcional para el datáfono / extracto. */
  description?: string;
  /**
   * Business-Code del comercio (clave HMAC). Si no viene, cae al env
   * KUSHKI_BP_BUSINESS_CODE.
   */
  businessCode?: string | null;
};

export type CloudTerminalChargeResult = {
  /** Estado FINAL del cobro síncrono. */
  status: "approved" | "declined" | "error";
  /** Referencia que guardamos en Payment.providerRef. */
  providerRef: string;
  message?: string;
  httpStatus?: number;
  raw?: unknown;
};

function pick(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/**
 * Cobra SÍNCRONO en el datáfono: POST /terminal/v1/{serial}/sync/charge.
 * La request se queda esperando hasta ~90s mientras el cliente pasa la
 * tarjeta; el resultado (aprobada/rechazada) vuelve en la misma respuesta.
 * NO hay webhook — el caller settlea con lo que devuelve esta función.
 */
export async function pushPaymentToCloudTerminal(
  args: CloudTerminalPushArgs,
): Promise<CloudTerminalChargeResult> {
  const businessCode = resolveBusinessCode(args.businessCode);
  // COP no tiene decimales → unidades mayores (pesos enteros).
  const amount = Math.round(args.amountCents / 100);
  // amount es un OBJETO en el contrato CO. Cobramos el total como base sin
  // IVA discriminado (la facturación DIAN la maneja MESAPAY aparte): todo
  // en subtotal_iva0, iva 0.
  const payload = {
    amount: {
      iva: 0,
      subtotal_iva: 0,
      subtotal_iva0: amount,
      extra_taxes: { airport_tax: 0, iac: 0, ice: 0, travel_agency: 0 },
    },
    client_transaction_id: args.reference,
  };

  // Firmamos y enviamos EXACTAMENTE este string (byte-idéntico al firmado).
  const raw = JSON.stringify(payload);
  const ts = Date.now().toString();
  const authorization = signBody(raw, businessCode);
  const url = baseUrl() + pushPath(args.serialNumber);

  console.log("[kushki/cloud-terminal] charge", {
    url,
    serialNumber: args.serialNumber,
    amount,
    reference: args.reference,
    bodyLen: raw.length,
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
    // No sabemos si se cobró o no → error (no settle). El mesero reintenta.
    return {
      status: "error",
      providerRef: args.reference,
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
    text.slice(0, 400) || "(empty)",
  );

  const providerRef =
    pick(json, [
      "transactionReference",
      "ticketNumber",
      "transaction_id",
      "client_transaction_id",
      "id",
    ]) || args.reference;
  const message = pick(json, [
    "message",
    "responseText",
    "declineCode",
    "responseCode",
  ]);

  if (!res.ok) {
    // 5xx → error retryable; 4xx → no cobrado (rechazo/validación). En ambos
    // NO marcamos pagado; surface el mensaje para el mesero/logs.
    return {
      status: res.status >= 500 ? "error" : "declined",
      providerRef,
      message: message || `http_${res.status}`,
      httpStatus: res.status,
      raw: json,
    };
  }

  // 2xx: aprobado salvo que el body diga explícitamente lo contrario.
  const statusStr = pick(json, ["status", "transactionStatus"])?.toUpperCase();
  const explicitlyDeclined =
    statusStr === "DECLINED" ||
    statusStr === "REJECTED" ||
    (json as { approved?: boolean })?.approved === false;
  if (explicitlyDeclined) {
    return {
      status: "declined",
      providerRef,
      message: message || "declined",
      httpStatus: res.status,
      raw: json,
    };
  }
  return {
    status: "approved",
    providerRef,
    message,
    httpStatus: res.status,
    raw: json,
  };
}

/**
 * Cancela un cobro encolado en el datáfono. Best-effort — mismo esquema de
 * firma; el path exacto del cancel se confirma con la doc del comercio.
 */
export async function cancelCloudTerminalPayment(
  serialNumber: string,
  reference: string,
  businessCode?: string | null,
): Promise<void> {
  let code: string;
  try {
    code = resolveBusinessCode(businessCode);
  } catch {
    return; // sin business code no hay con qué firmar; nada que cancelar
  }
  const payload = { client_transaction_id: reference };
  const raw = JSON.stringify(payload);
  const url =
    baseUrl() +
    (env.KUSHKI_CLOUD_TERMINAL_CANCEL_PATH || "/api/v1/{serial}/cancel").replace(
      "{serial}",
      encodeURIComponent(serialNumber),
    );
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: signBody(raw, code),
        timestamp: Date.now().toString(),
      },
      body: raw,
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(
        `[kushki/cloud-terminal] cancel ${res.status} (best-effort)`,
      );
    }
  } catch (err) {
    console.warn("[kushki/cloud-terminal] cancel error (best-effort)", err);
  }
}
