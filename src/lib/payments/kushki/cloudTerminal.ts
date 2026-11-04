import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "crypto";
import { env } from "../../env";
import { getKushkiModeSync, type KushkiMode } from "../../platformConfig";

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

/**
 * Host del Cloud Terminal según el modo EFECTIVO del comercio. Sólo
 * "production" pega al host real (cloudt). Sandbox —y cualquier otro caso,
 * incluido el "desacoplado" mock+Business-Code— van al host UAT
 * (uat-cloudt). Antes había un override por env (KUSHKI_CLOUD_TERMINAL_URL)
 * que forzaba prod siempre; se quitó para que el datáfono siga el modo del
 * comercio (sandbox → UAT).
 */
export function terminalBaseUrl(mode?: KushkiMode): string {
  const m = mode ?? getKushkiModeSync();
  return m === "production" ? BASE_URL.production : BASE_URL.sandbox;
}

function pushPath(serial: string): string {
  const tmpl =
    env.KUSHKI_CLOUD_TERMINAL_PATH || "/terminal/v1/{serial}/sync/charge";
  return tmpl.replace("{serial}", encodeURIComponent(serial));
}

// Síncrono: la doc sugiere timeout ≥90s por la latencia del relay.
const CHARGE_TIMEOUT_MS = 95_000;

export function resolveBusinessCode(explicit?: string | null): string {
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
export function tokenPassword(token: string, tsSeconds: number): string {
  return md5hex((token + formattedDate(tsSeconds)).padEnd(32, "0"));
}
export function buildAuthHash(
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
export function encryptPayload(
  text: string,
  tsSeconds: number,
  password: string,
): string {
  const iv = randomBytes(16);
  const c = createCipheriv("aes-256-cbc", aesKey(tsSeconds, password), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return iv.toString("hex") + ":" + enc.toString("hex");
}
export function decryptData(
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
  /** Modo efectivo del comercio. production → cloudt; resto → uat-cloudt. */
  mode?: KushkiMode;
  /**
   * `client_transaction_id` (UUID v4) del cobro. Quien llama lo genera y lo
   * guarda ANTES de empujar, para poder buscar el resultado en Kushki si la
   * respuesta no llega (`searchCloudTerminalCharge`). Si falta, se genera.
   */
  clientTransactionId?: string;
};

export type CloudTerminalChargeResult = {
  /**
   * - `approved`: el datáfono aprobó (señal explícita).
   * - `declined`: el banco rechazó la tarjeta. No se cobró.
   * - `canceled`: el datáfono dijo explícitamente que el proceso se canceló
   *   ANTES de autorizar (el tarjetahabiente canceló, o se venció la lectura
   *   de la tarjeta / el PIN). No se cobró. Ver `isTerminalCancelAnswer`.
   * - `rejected`: Kushki rechazó la SOLICITUD por validación (HTTP 4xx de
   *   `CLOUD_TERMINAL_VALIDATION_STATUSES`) ANTES de mandarla al equipo:
   *   Business-Code, serial o firma que no valida. No se cobró.
   * - `error`: transporte (timeout, red, 5xx) o cuerpo sin señal clara: no se
   *   sabe si el equipo cobró; el pago queda incierto para conciliar. Si el
   *   equipo SÍ respondió que no aprobó (sin ser definitivo), viene con
   *   `deviceAnswered`.
   */
  status: "approved" | "declined" | "canceled" | "rejected" | "error";
  /** transaction_reference (para void/refund) o el client_transaction_id. */
  providerRef: string;
  message?: string;
  httpStatus?: number;
  /** Detalle de Kushki ({type, code, message}) cuando lo mandó. */
  failure?: CloudTerminalAnswer;
  /**
   * El datáfono (o Kushki por él) contestó, con HTTP 200, que NO aprobó:
   * `canceled`, o un `error` con un código del equipo que no es definitivo
   * (p. ej. TER-003 "ocupado con otra transacción"). Es lo que separa "el
   * equipo dijo que no" de "no hubo respuesta" (timeout, red, 5xx, o códigos
   * que significan que el equipo no respondió): sólo con respuesta el staff
   * puede cerrar el intento sin esperar. Ver `isTerminalDeviceAnswer`.
   */
  deviceAnswered?: boolean;
  raw?: unknown;
};

/** El detalle `{type, code, message}` con el que Kushki ONE contesta un error. */
export type CloudTerminalAnswer = { type?: string; code?: string; message?: string };

/**
 * ¿El datáfono dijo EXPLÍCITAMENTE que no cobró, porque el proceso se
 * canceló antes de autorizar? Sólo estos (catálogo de errores de Kushki ONE
 * Colombia, docs.kushki.com/co/card-present-payments/kushki-one/error-catalog-kushkione):
 *
 *   - `TERMINAL` / `TER-004` en un endpoint de pago: «cancelación del
 *     tarjetahabiente» (el catálogo: «en un endpoint de pago el
 *     tarjetahabiente canceló: no reintentes»). Es lo que mandó el equipo de
 *     Son y Melona el 2026-11-04: `User cancel the process`.
 *   - `TERMINAL-SUNMI` / `MAN-30005` («Input PIN timeout»): se venció la
 *     lectura de la tarjeta o el ingreso del PIN; el catálogo lo trata «como
 *     una cancelación esperada, no como una falla». Sin tarjeta o sin PIN no
 *     hay autorización.
 *   - `TERMINAL-SUNMI` / `-1` con «User cancel the process»: la forma vieja
 *     de la misma cancelación (la mandaba el equipo antes de TER-004). `-1`
 *     solo, sin ese mensaje, es genérico: no cuenta.
 *
 * Nada más. TER-002 (el equipo no responde), TER-172 (se excedió el tiempo
 * máximo de la operación, con la tarjeta ya presentada) o cualquier otro
 * código no dicen que la autorización no ocurrió: un rechazo equivocado
 * libera la cuenta y puede terminar en un cobro doble.
 */
export function isTerminalCancelAnswer(answer: CloudTerminalAnswer | null | undefined): boolean {
  if (!answer) return false;
  const type = answer.type?.trim().toUpperCase();
  const code = answer.code?.trim().toUpperCase();
  if (type === "TERMINAL" && code === "TER-004") return true;
  if (type === "TERMINAL-SUNMI" && code === "MAN-30005") return true;
  if (type === "TERMINAL-SUNMI" && code === "-1" && /user cancel/i.test(answer.message ?? "")) return true;
  return false;
}

/**
 * Tipos de error de Kushki ONE que vienen del equipo, del adquirente o de la
 * validación de la operación: cuando llegan con HTTP 200, alguien contestó
 * que NO aprobó. `INTERNAL`, `NOT_FOUND` o un tipo desconocido no cuentan: es
 * la plataforma fallando, no el equipo contestando.
 */
const DEVICE_ANSWER_TYPES: ReadonlySet<string> = new Set([
  "TERMINAL",
  "TERMINAL-SUNMI",
  "ACQUIRER",
  "CONFIGURATION",
  "PARAMETER",
  "AUTH",
]);

/**
 * Códigos que, aunque vengan del equipo, dicen que el equipo NO contestó o
 * que se cortó en medio: se tratan como "sin respuesta" (puede haber
 * cobrado). TER-002: «Terminal … is not responding». TER-172: «The maximum
 * operation time was exceeded» (en el catálogo, con la tarjeta ya
 * presentada).
 */
const NO_ANSWER_CODES: ReadonlySet<string> = new Set(["TER-002", "TER-172"]);

/**
 * ¿Esto es una respuesta del equipo que dice que no aprobó (aunque no sea
 * definitiva)? Con ella el staff puede reintentar o cancelar al instante,
 * confirmando en la pantalla del datáfono. Sin ella, el cobro queda como "sin
 * respuesta" (3 minutos + administrador + evidencia).
 */
export function isTerminalDeviceAnswer(answer: CloudTerminalAnswer | null | undefined): boolean {
  if (!answer?.code) return false;
  if (isTerminalCancelAnswer(answer)) return true;
  const type = answer.type?.trim().toUpperCase() ?? "";
  if (!DEVICE_ANSWER_TYPES.has(type)) return false;
  return !NO_ANSWER_CODES.has(answer.code.trim().toUpperCase());
}

/** "TERMINAL/TER-004": cómo se guarda y se muestra el código de una respuesta. */
export function terminalAnswerCode(answer: CloudTerminalAnswer | null | undefined): string | null {
  const parts = [answer?.type, answer?.code].filter((p): p is string => !!p && !!p.trim());
  return parts.length ? parts.join("/").slice(0, 80) : null;
}

/**
 * Respuestas HTTP con las que Kushki dice que NO aceptó la solicitud: no la
 * validó (firma, Business-Code, serial, payload) y por lo tanto nunca llegó
 * al datáfono. Caso real (Son y Melona, 2026-10-31): `400
 * {"type":"INTERNAL","code":"CLOUDPAYMENT_VALIDATION_ERROR","message":"Unable
 * to validate the CloudPayment request."}`. 5xx, 408/429, timeout y errores
 * de red NO están: ahí no se sabe si el equipo cobró.
 */
export const CLOUD_TERMINAL_VALIDATION_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 422]);

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
 * Monto que se manda en `amount.subtotal_iva0`.
 *
 * PRODUCCIÓN: unidad mínima de la moneda, que en COP es el peso entero
 * (Kushki ONE, «Formato de montos»: 12.000 COP se manda 12000; «si agregas 00
 * al final de un monto en COP, cobrarás 100 veces más»). Mandar los
 * centavos tal cual llevó $91.850 al datáfono de Son y Melona como
 * $9.185.000 (2026-11-04).
 *
 * UAT: el ambiente de pruebas sí divide por 100 (2026-06-02: 43890 cobró
 * $438,90; 2026-08-05: 110000 autorizó 1100), así que ahí van los centavos.
 */
export function cloudTerminalAmount(amountCents: number, mode: KushkiMode): number {
  return mode === "production" ? Math.round(amountCents) / 100 : Math.round(amountCents);
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
  const amountMinor = cloudTerminalAmount(args.amountCents, args.mode ?? getKushkiModeSync());
  const clientTxnId = args.clientTransactionId || randomUUID(); // idempotency key (UUID v4)
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
      // Modelo del equipo. El acquirer parece validarlo (rechazaba "MESAPAY"
      // con ACQUIRER/E001). Default = el valor que funciona en el Postman del
      // comercio; override por env si el datáfono es otro modelo.
      device: env.KUSHKI_CLOUD_TERMINAL_DEVICE,
    },
  };

  const ts = Math.floor(Date.now() / 1000); // SEGUNDOS
  const password = tokenPassword(businessCode + serial, ts);
  const authHash = buildAuthHash(payload, ts, password);
  const encryptedData = encryptPayload(JSON.stringify(payload), ts, password);
  const url = terminalBaseUrl(args.mode) + pushPath(serial);

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

  const obj = asObj(json) || {};
  const txStatus = pick(rawResp, ["transaction_status"])?.toUpperCase();

  // ⚠️ APROBADO sólo con señal EXPLÍCITA. El datáfono devuelve HTTP 200
  // también cuando el cliente cancela o falla, con cuerpo {type,code,message}
  // (ej. {"type":"TERMINAL-SUNMI","code":"-1","message":"User cancel the
  // process"}) y SIN approved/transaction_status. Nunca asumir aprobado.
  const approvedOk =
    res.ok && (obj.approved === true || txStatus === "APPROVAL");
  // El banco autorizó OTRO monto (`authorized_amount` viene en pesos, en
  // UAT y en producción): no se salda la cuenta. Queda incierto para que
  // alguien lo concilie contra el comprobante del datáfono.
  const authorized = rawResp?.authorized_amount;
  const expectedPesos = Math.round(args.amountCents) / 100;
  if (approvedOk && typeof authorized === "number" && authorized !== expectedPesos) {
    console.error("[kushki/cloud-terminal] monto autorizado distinto al de la cuenta", {
      reference: args.reference,
      authorized,
      expectedPesos,
    });
    return {
      status: "error",
      providerRef,
      message: `authorized_amount_mismatch: ${authorized} != ${expectedPesos}`,
      httpStatus: res.status,
      raw: json,
    };
  }
  if (approvedOk) {
    return {
      status: "approved",
      providerRef,
      message:
        pick(obj, ["message"]) ||
        pick(asObj(rawResp)?.kushki_response, ["message"]),
      httpStatus: res.status,
      raw: json,
    };
  }

  // No aprobado. Detalle desde {type,code,message} (top-level con HTTP 200)
  // o {failure:{...}} (con 4xx).
  const failure = asObj(obj.failure) || obj;
  const type = pick(failure, ["type"]);
  const code = pick(failure, ["code"]);
  const fmsg = pick(failure, ["message"]);
  const answer: CloudTerminalAnswer | undefined = type || code || fmsg ? { type, code, message: fmsg } : undefined;
  const label =
    [type, code].filter(Boolean).join("/") +
    (fmsg ? `${type || code ? ": " : ""}${fmsg}` : "");
  // - Rechazo de tarjeta (banco) → "declined".
  // - El equipo canceló antes de autorizar (TER-004 / MAN-30005, ver
  //   `isTerminalCancelAnswer`) → "canceled": no se cobró, la cuenta se libera.
  //   Los endpoints de pago de Kushki ONE contestan SIEMPRE 200: la
  //   cancelación sólo cuenta con 200 y sin señal de rechazo del banco.
  // - Solicitud que Kushki no validó (4xx) → "rejected": nunca llegó al equipo.
  // - Cualquier otra cosa (otro código del equipo, 5xx, cuerpo vacío) →
  //   "error": no se sabe si cobró, queda incierto. Si el equipo contestó
  //   (`deviceAnswered`), el staff puede cerrarlo sin esperar.
  const isDecline = txStatus === "DECLINED" || obj.approved === false;
  const canceled = res.ok && txStatus !== "DECLINED" && isTerminalCancelAnswer(answer);
  const rejected = !canceled && !isDecline && CLOUD_TERMINAL_VALIDATION_STATUSES.has(res.status);
  const status: CloudTerminalChargeResult["status"] = canceled
    ? "canceled"
    : isDecline
      ? "declined"
      : rejected
        ? "rejected"
        : "error";
  return {
    status,
    providerRef,
    message: label || pick(obj, ["message"]) || `http_${res.status}`,
    httpStatus: res.status,
    ...(answer ? { failure: answer } : {}),
    ...(status === "canceled" || (status === "error" && res.ok && isTerminalDeviceAnswer(answer))
      ? { deviceAnswered: true }
      : {}),
    raw: json,
  };
}

export type CloudTerminalAbortResult = {
  /**
   * - `aborted`: Kushki aceptó cancelar el cobro en curso (200). El cobro
   *   síncrono que lo esperaba vuelve con la respuesta de la cancelación.
   * - `not_active`: no había un cobro en curso en el equipo (409): ya terminó
   *   o nunca llegó.
   * - `error`: cualquier otra cosa (red, 5xx, sin credencial). Best-effort:
   *   no cambia nada en MESAPAY.
   */
  status: "aborted" | "not_active" | "error";
  httpStatus?: number;
};

/**
 * Aborta el cobro en curso en el datáfono: `POST /terminal/v1/{serial}/sync/abort`
 * (api-docs.kushkipagos.com/colombia/kushki-one/cloud-services/payment/sync/abort).
 * Sin cuerpo; la doc pide igual `Authorization` y `timestamp`, que se firman
 * como el cobro con un payload vacío. Sólo sirve mientras el cobro está
 * activo en el equipo (después, 409). Best-effort: NUNCA libera la cuenta por
 * sí solo; quien la libera es la respuesta del cobro síncrono.
 */
export async function cancelCloudTerminalPayment(
  serialNumber: string,
  _reference: string,
  businessCode?: string | null,
  mode?: KushkiMode,
): Promise<CloudTerminalAbortResult> {
  if (!serialNumber) return { status: "error" };
  try {
    const ts = Math.floor(Date.now() / 1000); // SEGUNDOS
    const password = tokenPassword(resolveBusinessCode(businessCode) + serialNumber, ts);
    const url =
      terminalBaseUrl(mode) +
      `/terminal/v1/${encodeURIComponent(serialNumber)}/sync/abort`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${buildAuthHash({}, ts, password)}`,
        timestamp: String(ts),
      },
      cache: "no-store",
    });
    console.log(`[kushki/cloud-terminal] abort ${res.status}`, { serialNumber });
    if (res.ok) return { status: "aborted", httpStatus: res.status };
    if (res.status === 409) return { status: "not_active", httpStatus: res.status };
    return { status: "error", httpStatus: res.status };
  } catch (err) {
    console.warn("[kushki/cloud-terminal] abort error (best-effort)", err);
    return { status: "error" };
  }
}

// Una consulta corta: si Kushki no contesta en 20 s, se reintenta en la
// próxima vuelta (o queda "sin respuesta").
const SEARCH_TIMEOUT_MS = 20_000;

export type CloudTerminalSearchArgs = {
  serialNumber: string;
  /** El `client_transaction_id` con el que se empujó el cobro. */
  clientTransactionId: string;
  /** Monto TOTAL de la cuenta en centavos, para validar lo autorizado. */
  amountCents: number;
  businessCode?: string | null;
  mode?: KushkiMode;
};

export type CloudTerminalSearchResult =
  /** El adquirente registró la venta APROBADA por el monto de la cuenta. */
  | { status: "approved"; transactionReference: string; approvalCode?: string; raw: unknown }
  /** El adquirente registró la venta RECHAZADA (y nada aprobado). */
  | { status: "declined"; transactionReference?: string; raw: unknown }
  /** Kushki no tiene (todavía) ninguna transacción con ese id. */
  | { status: "not_found" }
  /**
   * Hay algo, pero no se puede decidir solo: una reversión/anulación del
   * mismo cobro, un monto aprobado distinto al de la cuenta, o un estado que
   * no conocemos. Lo resuelve una persona con el comprobante.
   */
  | { status: "unknown"; reason: "reversed" | "amount_mismatch" | "unrecognized"; raw: unknown }
  /** La consulta misma falló (red, 5xx, cuerpo ilegible). */
  | { status: "error"; httpStatus?: number };

/**
 * Busca el resultado REAL de un cobro del datáfono cuando la respuesta del
 * cobro síncrono no llegó: `POST /terminal/v1/{serial}/sync/transaction_search_online`
 * (api-docs.kushkipagos.com/colombia/kushki-one/cloud-services/payment/search),
 * firmado y cifrado como el cobro, con el filtro `client_transaction_id` y
 * sin rango de fechas (`start_date`/`end_date` = 0). Cada ítem trae
 * `transaction_status` (`APPROVAL` / `DECLINED`, "as recorded by the
 * acquirer"), `transaction_type` (`SALE`, `REVERSE`, `VOID`…),
 * `transaction_reference` y `approved_transaction_amount`.
 *
 * Nació con Son y Melona (2026-11-04): el gateway de Kushki cortó dos cobros
 * síncronos a los 60 s con un 504 HTML mientras el datáfono todavía esperaba
 * la tarjeta. Nunca llama a Kushki desde los tests: `fetch` es un doble.
 */
export async function searchCloudTerminalCharge(
  args: CloudTerminalSearchArgs,
): Promise<CloudTerminalSearchResult> {
  if (!args.serialNumber || !args.clientTransactionId) return { status: "error" };
  let businessCode: string;
  try {
    businessCode = resolveBusinessCode(args.businessCode);
  } catch {
    return { status: "error" };
  }
  const mode = args.mode ?? getKushkiModeSync();
  const payload: Record<string, unknown> = {
    page: 1,
    size: 20,
    filters: { client_transaction_id: args.clientTransactionId, start_date: 0, end_date: 0 },
  };
  const ts = Math.floor(Date.now() / 1000); // SEGUNDOS
  const password = tokenPassword(businessCode + args.serialNumber, ts);
  const url =
    terminalBaseUrl(mode) +
    `/terminal/v1/${encodeURIComponent(args.serialNumber)}/sync/transaction_search_online`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${buildAuthHash(payload, ts, password)}`,
        timestamp: String(ts),
      },
      body: JSON.stringify({ data: encryptPayload(JSON.stringify(payload), ts, password) }),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    console.warn("[kushki/cloud-terminal] search error", err);
    return { status: "error" };
  }
  clearTimeout(timer);
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const dataField = asObj(json)?.data;
  if (typeof dataField === "string" && /^[0-9a-f]+:[0-9a-f]+$/i.test(dataField)) {
    try {
      json = JSON.parse(decryptData(dataField, ts, password));
    } catch {
      json = null;
    }
  }
  const items = asObj(json)?.items;
  console.log(`[kushki/cloud-terminal] search ${res.status}`, {
    clientTransactionId: args.clientTransactionId,
    items: Array.isArray(items) ? items.length : null,
  });
  if (!res.ok || !Array.isArray(items)) return { status: "error", httpStatus: res.status };

  // Sólo lo que es de ESTE cobro, por su `client_transaction_id` EXACTO. Un
  // ítem sin id no se atribuye: si el filtro del endpoint no se aplicara, una
  // venta aprobada de otra mesa saldaría ésta. Sin coincidencia → incierto.
  const mine = items
    .map(asObj)
    .filter((i): i is Record<string, unknown> => !!i)
    .filter((i) => pick(i, ["client_transaction_id"]) === args.clientTransactionId);
  if (mine.length === 0) return { status: "not_found" };

  const type = (i: Record<string, unknown>) => (pick(i, ["transaction_type"]) ?? "SALE").toUpperCase();
  const txStatus = (i: Record<string, unknown>) => pick(i, ["transaction_status"])?.toUpperCase();
  // Una reversión (la plataforma la genera sola si se corta la comunicación
  // con el equipo), anulación o devolución del mismo cobro: ya no es "se
  // cobró" ni "no se cobró" sin mirar. Que lo resuelva una persona.
  if (mine.some((i) => ["REVERSE", "VOID", "REFUND"].includes(type(i)))) {
    return { status: "unknown", reason: "reversed", raw: json };
  }
  const sales = mine.filter((i) => type(i) === "SALE");
  const approved = sales.find((i) => txStatus(i) === "APPROVAL");
  if (approved) {
    // Lo autorizado tiene que ser la cuenta: en pesos (como `authorized_amount`)
    // o, en UAT, lo que se mandó. Sin monto u otro monto → a mano: un
    // aprobado recuperado nunca salda sin comprobar cuánto se cobró.
    const authorized = approved.approved_transaction_amount;
    const pesos = Math.round(args.amountCents) / 100;
    const sent = cloudTerminalAmount(args.amountCents, mode);
    if (typeof authorized !== "number" || (authorized !== pesos && authorized !== sent)) {
      console.error("[kushki/cloud-terminal] search: monto aprobado distinto al de la cuenta", {
        clientTransactionId: args.clientTransactionId,
        authorized,
        pesos,
      });
      return { status: "unknown", reason: "amount_mismatch", raw: json };
    }
    const transactionReference = pick(approved, ["transaction_reference"]) ?? args.clientTransactionId;
    return { status: "approved", transactionReference, approvalCode: pick(approved, ["approval_code"]), raw: json };
  }
  if (sales.length > 0 && sales.every((i) => txStatus(i) === "DECLINED")) {
    return { status: "declined", transactionReference: pick(sales[0], ["transaction_reference"]), raw: json };
  }
  return { status: "unknown", reason: "unrecognized", raw: json };
}
