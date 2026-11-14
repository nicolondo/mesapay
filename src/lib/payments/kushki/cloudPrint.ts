import { displayOrderCode } from "@/lib/orderCode";
import { randomUUID } from "crypto";
import { createTranslator } from "next-intl";
import esMessages from "../../../../messages/es.json";
import { wrap } from "@/lib/escpos/commands";

const esInvoiceTranslator = createTranslator({ locale: "es", messages: esMessages, namespace: "emailInvoice" });
// El catálogo importado estáticamente tipa las claves; el traductor que
// llega por parámetro (`getEmailTranslator`) no. Se expone con clave
// `string` para que los dos encajen en la misma firma.
const defaultInvoiceTranslator = (
  key: string,
  values?: Record<string, string | number>,
): string => esInvoiceTranslator(key as Parameters<typeof esInvoiceTranslator>[0], values);
import type { KushkiMode } from "../../platformConfig";
import type { InvoiceSnapshot } from "@/lib/invoice";
import {
  formatInvoiceNumber,
  invoicePayableOf,
  itemDetailLines,
  payableLabelsFrom,
  payableRows,
  summaryLabelsFrom,
  summaryRows,
} from "@/lib/invoice";
import { groupInvoiceLines } from "@/lib/invoiceLines";
import {
  buildAuthHash,
  decryptData,
  encryptPayload,
  resolveBusinessCode,
  terminalBaseUrl,
  tokenPassword,
} from "./cloudTerminal";
import { formatNumber } from "@/lib/format";

/**
 * Kushki ONE — Print API (Cloud), contrato verificado el 2026-11-13
 * (api-docs.kushkipagos.com/colombia/kushki-one/cloud-services/print, Beta):
 *
 *   CREAR   POST {cloudt|uat-cloudt}/terminal/v1/{serial}/sync/print
 *           { printJobId, commands[], externalReference? }
 *           → 202 { printJobId, status: "PENDING" }: ENCOLADO, no impreso.
 *   ESTADO  POST {cloudt|uat-cloudt}/terminal/v1/{serial}/sync/print_job
 *           { print_job_id }  (snake_case, en el cuerpo)
 *           → 200 { printJobId, status: PENDING | IN_PROGRESS | COMPLETED
 *             | FAILED, errorCode? (OUT_OF_PAPER…), errorMessage? }
 *
 * Por eso un 202 NO es "impreso": `waitForCloudPrintJob` sondea el estado
 * cada ~2,5 s hasta ~30 s y sólo COMPLETED es impreso. Reintentar con el
 * MISMO `printJobId` no imprime doble (el terminal deduplica).
 *
 * Mismo transporte cifrado del cobro (password businessCode+serial, Basic
 * SHA512, timestamp, cuerpo AES-256-CBC en { data }). Comandos: `type` en
 * minúscula, enums (align, dividerType, errorLevel) en MAYÚSCULA; `text`
 * con "\n" y tamaños 24 (normal) / 32 (subtítulo) / 48 (título); `feed`
 * antes de `cut`.
 */

export type PrintCommand =
  | { type: "text"; text: string; align?: "LEFT" | "CENTER" | "RIGHT"; size?: number; bold?: boolean; italic?: boolean; underline?: boolean }
  | { type: "columns"; columns: Array<{ text: string; weight?: number; align?: "LEFT" | "CENTER" | "RIGHT" }> }
  | { type: "divider"; dividerType?: "SOLID" | "DOTTED" | "EMPTY"; offset?: number }
  | { type: "feed"; lines?: number }
  | { type: "space"; pixels?: number }
  | { type: "cut" }
  | { type: "qr"; content: string; dotSize?: number; errorLevel?: "L" | "M" | "Q" | "H"; align?: "LEFT" | "CENTER" | "RIGHT" };

/** $ 43,890 — sin decimales, con la convención de `@/lib/format` (la tirilla COP no usa centavos). */
function money(cents: number): string {
  return "$ " + formatNumber(Math.round(cents / 100));
}

/**
 * Tirilla de la factura a partir del snapshot emitido (misma data que la
 * versión imprimible web). Termina con feed + cut como pide la doc.
 */
export function buildInvoiceCommands(
  snapshot: InvoiceSnapshot,
  invoiceNumber: number,
  invoiceUrl: string,
  // Traductor del namespace `emailInvoice` (el mismo del correo y de la
  // térmica): las filas de impuesto y los totales salen de ahí para que
  // el datáfono diga lo mismo que el papel de la caja.
  t: (key: string, values?: Record<string, string | number>) => string = defaultInvoiceTranslator,
  /**
   * La orden HOY: la propina REAL de una factura emitida antes de cobrar,
   * para el TOTAL A PAGAR (ver `invoicePayableOf`).
   */
  order?: { tipCents: number } | null,
): PrintCommand[] {
  const c: PrintCommand[] = [];
  const center = (
    text: string,
    size = 24,
    bold = false,
  ): PrintCommand => ({ type: "text", text: text + "\n", align: "CENTER", size, bold });

  c.push(center(snapshot.restaurantName, 32, true));
  if (snapshot.legalName) c.push(center(snapshot.legalName));
  if (snapshot.taxId) c.push(center(`NIT ${snapshot.taxId}`));
  if (snapshot.legalAddress) {
    c.push(center(snapshot.legalAddress + (snapshot.legalCity ? ` · ${snapshot.legalCity}` : "")));
  }
  if (snapshot.legalPhone) c.push(center(`Tel ${snapshot.legalPhone}`));
  c.push({ type: "divider", dividerType: "SOLID", offset: 10 });

  c.push(center(`FACTURA ${formatInvoiceNumber(snapshot, invoiceNumber)}`, 32, true));
  const paidAt = new Date(snapshot.paidAtIso);
  c.push(
    center(
      `${snapshot.tableLabel} · ${displayOrderCode(snapshot.shortCode)} · ` +
        paidAt.toLocaleString("es-CO", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Bogota",
        }),
    ),
  );

  if (snapshot.customer) {
    c.push({ type: "divider", dividerType: "DOTTED", offset: 8 });
    c.push({ type: "text", text: `Cliente: ${snapshot.customer.name}\n` });
    c.push({
      type: "text",
      text: `${snapshot.customer.docType} ${snapshot.customer.docNumber}\n`,
    });
  }

  c.push({ type: "divider", dividerType: "DOTTED", offset: 8 });
  // Repetidos AGRUPADOS ("2x Bretaña"), con los modificadores y la nota
  // debajo — igual que la térmica de la caja (ver src/lib/invoiceLines.ts).
  for (const it of groupInvoiceLines(snapshot.items)) {
    c.push({
      type: "columns",
      columns: [
        { text: `${it.qty}x ${it.name}`, weight: 2, align: "LEFT" },
        { text: money(it.totalCents), weight: 1, align: "RIGHT" },
      ],
    });
    for (const d of itemDetailLines(it)) {
      c.push({ type: "text", text: `   ${d}\n` });
    }
  }
  c.push({ type: "divider", dividerType: "SOLID", offset: 8 });

  const totalRow = (label: string, amount: string): PrintCommand => ({
    type: "columns",
    columns: [
      { text: label, weight: 2, align: "LEFT" },
      { text: amount, weight: 1, align: "RIGHT" },
    ],
  });
  c.push(totalRow(t("subtotal"), money(snapshot.subtotalCents)));
  // Impuesto embebido congelado en la factura (base + "Incl. impoconsumo
  // 8%"), el que suman encima las líneas libres y el descuento del cliente
  // — las mismas filas, en el mismo orden, que la térmica y el correo
  // (`summaryRows`). Las facturas viejas salen igual que antes.
  for (const row of summaryRows(snapshot, summaryLabelsFrom(t))) {
    c.push(totalRow(row.label, (row.negative ? "-" : "") + money(row.cents)));
  }
  // Total factura (la venta), propina voluntaria y el TOTAL A PAGAR =
  // factura + propina, en negrita y más grande: rótulo y monto en dos
  // renglones, así a ese tamaño nunca se encima con nada.
  for (const row of payableRows(
    invoicePayableOf(snapshot, order),
    payableLabelsFrom(t, { einvoice: true }),
  )) {
    if (row.strong) {
      c.push({ type: "divider", dividerType: "SOLID", offset: 4 });
      c.push({ type: "text", text: row.label + "\n", align: "LEFT", size: 28, bold: true });
      c.push({ type: "text", text: money(row.cents) + "\n", align: "RIGHT", size: 32, bold: true });
    } else {
      c.push(totalRow(row.label, money(row.cents)));
    }
  }

  c.push({ type: "divider", dividerType: "DOTTED", offset: 8 });
  c.push(center(wrap(t("tipNoticeTitle"), 32).join("\n"), 24, true));
  c.push({ type: "text", text: wrap(t("tipNoticeBody"), 32).join("\n") + "\n", align: "LEFT", size: 24 });

  if (snapshot.dianResolution) {
    c.push({ type: "divider", dividerType: "DOTTED", offset: 8 });
    c.push(center(`Res. DIAN ${snapshot.dianResolution}`));
  }
  c.push({ type: "space", pixels: 16 });
  c.push({ type: "qr", content: invoiceUrl, dotSize: 6, errorLevel: "M", align: "CENTER" });
  c.push(center("Gracias por su visita"));
  c.push({ type: "feed", lines: 3 });
  c.push({ type: "cut" });
  return c;
}

export type PrintJobResult = {
  ok: boolean;
  printJobId: string;
  status?: string;
  message?: string;
  httpStatus?: number;
  raw?: unknown;
};

type TerminalTarget = {
  serialNumber: string;
  businessCode?: string | null;
  mode?: KushkiMode;
};

type CloudResponse = {
  /** HTTP del relay; null si no hubo respuesta (red o timeout). */
  httpStatus: number | null;
  /** El cuerpo, descifrado si venía cifrado. */
  body: Record<string, unknown>;
  /** "timeout" | "network_error" sin respuesta. */
  error?: string;
  /** Los primeros caracteres del cuerpo crudo, para el log. */
  rawText: string;
};

/**
 * Un POST cifrado al relay del Cloud Terminal (el mismo esquema del cobro).
 * No lanza: sin respuesta devuelve `httpStatus: null` y el motivo.
 */
async function cloudTerminalPost(
  target: TerminalTarget,
  path: "sync/print" | "sync/print_job",
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<CloudResponse> {
  const businessCode = resolveBusinessCode(target.businessCode);
  const ts = Math.floor(Date.now() / 1000);
  const password = tokenPassword(businessCode + target.serialNumber, ts);
  const authHash = buildAuthHash(payload, ts, password);
  const encryptedData = encryptPayload(JSON.stringify(payload), ts, password);
  const url = terminalBaseUrl(target.mode) + `/terminal/v1/${encodeURIComponent(target.serialNumber)}/${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    console.error("[kushki/cloud-print] network", { path, serial: target.serialNumber, aborted });
    return { httpStatus: null, body: {}, error: aborted ? "timeout" : "network_error", rawText: "" };
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  // La respuesta puede venir cifrada como en el cobro.
  const dataField = json && typeof json === "object" ? (json as Record<string, unknown>).data : undefined;
  if (typeof dataField === "string" && /^[0-9a-f]+:[0-9a-f]+$/i.test(dataField)) {
    try {
      json = JSON.parse(decryptData(dataField, ts, password));
    } catch {
      /* respuesta plana */
    }
  }
  const body = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  return { httpStatus: res.status, body, rawText: text.slice(0, 400) };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Encola la impresión en el datáfono. 202 + PENDING = ENCOLADO (no
 * impreso: ver `waitForCloudPrintJob`). La respuesta se registra siempre,
 * también la 2xx, para diagnosticar (sin datos del documento).
 */
export async function printOnCloudTerminal(args: TerminalTarget & {
  commands: PrintCommand[];
  externalReference?: string;
  printJobId?: string;
}): Promise<PrintJobResult> {
  const printJobId = args.printJobId ?? randomUUID();
  const payload: Record<string, unknown> = {
    printJobId,
    commands: args.commands,
    ...(args.externalReference ? { externalReference: args.externalReference } : {}),
  };
  const r = await cloudTerminalPost(args, "sync/print", payload, 20_000);
  const ok = r.httpStatus === 202 || r.httpStatus === 200;
  const logged = {
    serial: args.serialNumber,
    printJobId,
    commands: args.commands.length,
    httpStatus: r.httpStatus,
    status: str(r.body.status),
    message: str(r.body.message),
    ...(r.error && { error: r.error }),
  };
  if (ok) console.log("[kushki/cloud-print] encolada", logged);
  else console.error("[kushki/cloud-print] rechazada", { ...logged, body: r.rawText });
  return {
    ok,
    printJobId,
    status: str(r.body.status),
    message: str(r.body.message) ?? r.error,
    httpStatus: r.httpStatus ?? undefined,
    raw: r.body,
  };
}

export type CloudPrintJobStatus = "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";

export type CloudPrintJobState = {
  ok: boolean;
  httpStatus?: number;
  status?: CloudPrintJobStatus;
  errorCode?: string;
  errorMessage?: string;
  error?: string;
};

/** Estado de un trabajo de impresión (`/sync/print_job`). No lanza. */
export async function getCloudPrintJobStatus(
  args: TerminalTarget & { printJobId: string },
): Promise<CloudPrintJobState> {
  const r = await cloudTerminalPost(args, "sync/print_job", { print_job_id: args.printJobId }, 10_000);
  const status = str(r.body.status)?.toUpperCase();
  const known = status === "PENDING" || status === "IN_PROGRESS" || status === "COMPLETED" || status === "FAILED";
  const state: CloudPrintJobState = {
    ok: r.httpStatus === 200 && known,
    httpStatus: r.httpStatus ?? undefined,
    ...(known && { status: status as CloudPrintJobStatus }),
    ...(str(r.body.errorCode) && { errorCode: str(r.body.errorCode) }),
    ...(str(r.body.errorMessage) && { errorMessage: str(r.body.errorMessage)!.slice(0, 200) }),
    ...(r.error && { error: r.error }),
  };
  console.log("[kushki/cloud-print] estado", { serial: args.serialNumber, printJobId: args.printJobId, ...state });
  return state;
}

export type CloudPrintOutcome =
  /** El datáfono la imprimió. */
  | { state: "completed" }
  /** El datáfono la intentó y falló (sin papel…). */
  | { state: "failed"; errorCode?: string; errorMessage?: string }
  /** Sigue encolada (o no se supo) al vencer el tiempo: reintentar con el mismo id. */
  | { state: "pending"; lastStatus?: CloudPrintJobStatus };

/**
 * Sondea el estado cada `intervalMs` hasta COMPLETED o FAILED, o hasta
 * `timeoutMs`. Un error del sondeo (red, 5xx) no corta: se vuelve a
 * preguntar hasta el tiempo.
 */
export async function waitForCloudPrintJob(
  args: TerminalTarget & { printJobId: string },
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    getStatus?: (a: TerminalTarget & { printJobId: string }) => Promise<CloudPrintJobState>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<CloudPrintOutcome> {
  const intervalMs = opts.intervalMs ?? 2_500;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const getStatus = opts.getStatus ?? getCloudPrintJobStatus;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;
  let lastStatus: CloudPrintJobStatus | undefined;
  for (;;) {
    await sleep(intervalMs);
    const st = await getStatus(args);
    if (st.status) lastStatus = st.status;
    if (st.status === "COMPLETED") return { state: "completed" };
    if (st.status === "FAILED") {
      return {
        state: "failed",
        ...(st.errorCode && { errorCode: st.errorCode }),
        ...(st.errorMessage && { errorMessage: st.errorMessage }),
      };
    }
    if (now() >= deadline) return { state: "pending", ...(lastStatus && { lastStatus }) };
  }
}
