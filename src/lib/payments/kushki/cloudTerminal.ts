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
 * Cliente del Kushki ONE — Payment API (Cloud) para datáfonos SmartPOS.
 * Host cloudt.kushkipagos.com (prod) / uat-cloudt (UAT).
 *
 * AUTENTICACIÓN + CIFRADO (replica cloudpayment.middleware.ts; verificado
 * contra el pre-request de Postman del comercio):
 *   timestamp     = Unix en SEGUNDOS.
 *   password      = MD5( (businessCode + serial + "YYYY:MM:DD:HH:MM"UTC).padEnd(32,'0') )
 *   Authorization = "Basic " + SHA512( base64( JSON.stringify({...payload, key: base64(password+ts)}) ) )
 *   Body CIFRADO  = AES-256-CBC( JSON.stringify(payload), key = (ts + "___" + password)[:32], IV random )
 *                   → enviado como { "data": "<ivHex>:<cipherHex>" }
 *   ⚠️ la clave AES usa TRES guiones bajos ("___") entre ts y password.
 *
 * Cobro SÍNCRONO: POST /terminal/v1/{serial}/sync/charge bloquea hasta que
 * el cliente pasa la tarjeta. El resultado vuelve en la misma respuesta.
 */

const BASE_URL = {
  sandbox: "https://uat-cloudt.kushkipagos.com",
  production: "https://cloudt.kushkipagos.com",
} as const;

async function baseUrl(): Promise<string> {
  if (env.KUSHKI_CLOUD_TERMINAL_URL) return env.KUSHKI_CLOUD_TERMINAL_URL;
  const mode = await getKushkiMode();
  if (mode === "mock") {
    throw new Error("cloudTerminal must not be called in mock mode");
  }
  return BASE_URL[mode];
}

function pushPath(serial: string): string {
  const tmpl =
    env.KUSHKI_CLOUD_TERMINAL_PATH || "/terminal/v1/{serial}/sync/charge";
  return tmpl.replace("{serial}", encodeURIComponent(serial));
}

// Síncrono: la doc sugiere timeout ≥90s por la latencia del relay.
const CHARGE_TIMEOUT_MS = 95_000;

function resolveBusinessCode(explicit?: string | null): string {
  const code = explicit || env.KUSHKI_BP_BUSINESS_CODE;
  if (!code) {
    throw new Error(
      "Cloud Terminal sin Business-Code. Cargalo en Configuración → Datáfonos.",
    );
  }
  return code;
}

// ——— Cripto del Cloud Terminal ———
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
  return md5hex((token + formattedDate(tsSeconds)).padEnd(32, "0"));
}
function buildAuthHash(
  payload: Record<string, unknown>,
  tsSeconds: number,
  password: string,
): string {
  const withKey = { ...payload, key: b64(password + tsSeconds) };
  return sha512hex(b64(JSON.stringify(withKey)));
}
// ⚠️ TRES guiones bajos entre ts y password.
function aesKey(tsSeconds: number, password: string): Buffer {
  return Buffer.from((tsSeconds + "___" + password).substring(0, 32), "utf8");
}
function encryptPayload(
  text: string,
  tsSeconds: number,
  password: string,
): string {
  const iv = randomBytes(16);
  const c = createCipheriv("aes-256-cbc", aesKey(tsSeconds, password), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return iv.toString("hex") + ":" + enc.toString("hex");
}
function decryptData(
  data: string,
  tsSeconds: number,
  password: string,
): string {
  const [ivHex, ctHex] = data.split(":");
  const d = createDecipheriv(
    "aes-256-cbc",
    aesKey(tsSeconds, password),
    Buffer.from(ivHex, "hex"),
  );
  return Buffer.concat([
    d.update(Buffer.from(ctHex, "hex")),
    d.final(),
  ]).toString("utf8");
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
  /** Business-Code del comercio. Fallback al env. */
  businessCode?: string | null;
};

export type CloudTerminalChargeResult = {
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
 * Cobra SÍNCRONO en el datáfono. Devuelve el resultado final; el caller
 * settlea con eso.
 */
export async function pushPaymentToCloudTerminal(
  args: CloudTerminalPushArgs,
): Promise<CloudTerminalChargeResult> {
  const businessCode = resolveBusinessCode(args.businessCode);
  const serial = args.serialNumber;
  // El Cloud Terminal interpreta el monto en MINOR UNITS (centavos): cobra
  // value/100. amountCents YA está en centavos ($43.890 = 4.389.000), así
  // que se manda TAL CUAL (no dividir por 100, o cobraría $438,90).
  const amountMinor = Math.round(args.amountCents);
  const clientTxnId = randomUUID(); // idempotency key (UUID v4)
  const payload: Record<string, unknown> = {
    amount: {
      iva: 0,
      subtotal_iva: 0,
      subtotal_iva0: amountMinor,
      extra_taxes: { airport_tax: 0, iac: 0, ice: 0, travel_agency: 0 },
    },
    client_transaction_id: clientTxnId,
    metadata: {
      reference: args.reference,
      ...(args.customerEmail ? { customer_email: args.customerEmail } : {}),
      device: "MESAPAY",
    },
  };

  const ts = Math.floor(Date.now() / 1000); // SEGUNDOS
  const password = tokenPassword(businessCode + serial, ts);
  const authHash = buildAuthHash(payload, ts, password);
  const encryptedData = encryptPayload(JSON.stringify(payload), ts, password);
  const url = (await baseUrl()) + pushPath(serial);

  console.log("[kushki/cloud-terminal] charge", {
    url,
    serialNumber: serial,
    amountMinor,
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
        timestamp: String(ts),
      },
      body: JSON.stringify({ data: encryptedData }),
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
  // La respuesta puede venir cifrada como { data: "<ivHex>:<ctHex>" }.
  const dataField = asObj(json)?.data;
  if (typeof dataField === "string" && /^[0-9a-f]+:[0-9a-f]+$/i.test(dataField)) {
    try {
      const dec = decryptData(dataField, ts, password);
      json = JSON.parse(dec);
      console.log("[kushki/cloud-terminal] charge resp (descifrada):", dec.slice(0, 500));
    } catch (e) {
      console.warn("[kushki/cloud-terminal] no se pudo descifrar la respuesta", e);
    }
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
 * Authorization). Best-effort.
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
