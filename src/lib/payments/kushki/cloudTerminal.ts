import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "crypto";
import { env } from "../../env";
import { getKushkiMode } from "../../platformConfig";

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

// async: lee el modo de la DB (getKushkiMode warmea el cache). Antes usaba
// la versión sync, que tras un deploy fresco devolvía el default "mock" del
// env y tiraba "must not be called in mock mode" aunque la DB diga production.
async function baseUrl(): Promise<string> {
  if (env.KUSHKI_CLOUD_TERMINAL_URL) return env.KUSHKI_CLOUD_TERMINAL_URL;
  const mode = await getKushkiMode();
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

/** Business-Code = secreto compartido (firma + cifrado). Sin él no cobra. */
function resolveBusinessCode(explicit?: string | null): string {
  const code = explicit || env.KUSHKI_BP_BUSINESS_CODE;
  if (!code) {
    throw new Error(
      "Cloud Terminal sin Business-Code (secreto de firma/cifrado). " +
        "Cargalo en Configuración → Datáfonos.",
    );
  }
  return code;
}

// —— Esquema de auth/cifrado del Cloud Terminal CO. Replica el middleware de
// Kushki (pre-request de Postman que pasó el comercio):
//   timestamp en SEGUNDOS
//   password = MD5( (businessCode + serial + "YYYY:MM:DD:HH:MM"UTC).padEnd(32,'0') )
//   Authorization: Basic SHA512( base64( JSON.stringify({...body, key: base64(password+ts)}) ) )
//   body cifrado AES-256-CBC (key = (ts+"_"+password).slice(0,32), IV random)
//     y enviado como { data: "<ivHex>:<ctHex>" }

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formattedDate(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  return (
    `${d.getUTCFullYear()}:${pad2(d.getUTCMonth() + 1)}:${pad2(d.getUTCDate())}` +
    `:${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
  );
}

function md5hex(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}
function sha512hex(s: string): string {
  return createHash("sha512").update(s, "utf8").digest("hex");
}
function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

function tokenPassword(token: string, tsSeconds: number): string {
  const key = (token + formattedDate(tsSeconds)).padEnd(32, "0");
  return md5hex(key);
}

function buildAuthHash(
  data: Record<string, unknown>,
  tsSeconds: number,
  serial: string,
  businessCode: string,
): string {
  const password = tokenPassword(businessCode + serial, tsSeconds);
  const withKey = { ...data, key: b64(password + tsSeconds) };
  return sha512hex(b64(JSON.stringify(withKey)));
}

function aesKey(tsSeconds: number, serial: string, businessCode: string): Buffer {
  const password = tokenPassword(businessCode + serial, tsSeconds);
  return Buffer.from((tsSeconds + "_" + password).substring(0, 32), "utf8");
}

function encryptBody(
  text: string,
  tsSeconds: number,
  serial: string,
  businessCode: string,
): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", aesKey(tsSeconds, serial, businessCode), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return iv.toString("hex") + ":" + enc.toString("hex");
}

function decryptBody(
  payload: string,
  tsSeconds: number,
  serial: string,
  businessCode: string,
): string {
  const [ivHex, ctHex] = payload.split(":");
  const decipher = createDecipheriv(
    "aes-256-cbc",
    aesKey(tsSeconds, serial, businessCode),
    Buffer.from(ivHex, "hex"),
  );
  return Buffer.concat([
    decipher.update(Buffer.from(ctHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
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
  const serial = args.serialNumber;
  // COP no tiene decimales → unidades mayores (pesos enteros).
  const amount = Math.round(args.amountCents / 100);
  // client_transaction_id DEBE ser un UUID. Como el cobro es síncrono no
  // necesitamos matchearlo con un webhook.
  const clientTxnId = randomUUID();
  const payload: Record<string, unknown> = {
    amount: {
      iva: 0,
      subtotal_iva: 0,
      subtotal_iva0: amount,
      extra_taxes: { airport_tax: 0, iac: 0, ice: 0, travel_agency: 0 },
    },
    client_transaction_id: clientTxnId,
    metadata: {
      reference: args.reference,
      device: "MESAPAY",
    },
  };

  // timestamp en SEGUNDOS; el body se firma (Authorization) y se cifra.
  const ts = Math.floor(Date.now() / 1000);
  const inner = JSON.stringify(payload);
  const authHash = buildAuthHash(payload, ts, serial, businessCode);
  const encrypted = encryptBody(inner, ts, serial, businessCode);
  const url = (await baseUrl()) + pushPath(serial);

  console.log("[kushki/cloud-terminal] charge", {
    url,
    serialNumber: serial,
    amount,
    reference: args.reference,
    clientTxnId,
    ts,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHARGE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${authHash}`,
        timestamp: ts.toString(),
      },
      body: JSON.stringify({ data: encrypted }),
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
  // La respuesta puede venir cifrada como { data: "<ivHex>:<ctHex>" }.
  const dataField = (json as { data?: unknown } | null)?.data;
  if (typeof dataField === "string" && /^[0-9a-f]+:[0-9a-f]+$/i.test(dataField)) {
    try {
      const dec = decryptBody(dataField, ts, serial, businessCode);
      console.log("[kushki/cloud-terminal] charge resp (descifrada):", dec.slice(0, 400));
      json = JSON.parse(dec);
    } catch (e) {
      console.warn("[kushki/cloud-terminal] no se pudo descifrar la respuesta", e);
    }
  }

  const providerRef =
    pick(json, [
      "transactionReference",
      "ticketNumber",
      "transaction_id",
      "client_transaction_id",
      "id",
    ]) || clientTxnId;
  // Estructura de error: { failure: { type, code, message } } (a veces top-level).
  const failure =
    json && typeof json === "object" && "failure" in (json as object)
      ? (json as { failure: unknown }).failure
      : json;
  const errType = pick(failure, ["type"]);
  const errCode = pick(failure, ["code"]);
  const rawMsg = pick(failure, ["message", "responseText"]);
  const errLabel =
    [errType, errCode].filter(Boolean).join("/") +
    (rawMsg ? `${errType || errCode ? ": " : ""}${rawMsg}` : "");
  const message = errLabel || rawMsg || undefined;

  if (!res.ok) {
    // Los errores documentados (AUTH / PARAMETER / CONFIGURATION /
    // TERMINAL-SUNMI / TERMINAL-PRINTER) son operacionales, NO un rechazo de
    // tarjeta: la plata no se movió. Marcamos "error" (no settle) y surface
    // type/code/message para diagnosticar y reintentar.
    return {
      status: "error",
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
 * El cobro del Cloud Terminal CO es SÍNCRONO (sync/charge): no queda una
 * transacción encolada que cancelar. Se mantiene la firma por compatibilidad
 * con el provider; es no-op.
 */
export async function cancelCloudTerminalPayment(
  _serialNumber: string,
  _reference: string,
  _businessCode?: string | null,
): Promise<void> {
  return;
}
