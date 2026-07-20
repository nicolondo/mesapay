import { randomUUID } from "crypto";
import type { KushkiMode } from "../../platformConfig";
import type { InvoiceSnapshot } from "@/lib/invoice";
import { formatInvoiceNumber } from "@/lib/invoice";
import {
  buildAuthHash,
  decryptData,
  encryptPayload,
  resolveBusinessCode,
  terminalBaseUrl,
  tokenPassword,
} from "./cloudTerminal";

/**
 * Kushki ONE — Print API (Cloud). Manda un trabajo de impresión a la
 * impresora térmica del datáfono SmartPOS vía el relay cloud:
 *
 *   POST {cloudt|uat-cloudt}/terminal/v1/{serial}/sync/print/job
 *   body { printJobId, commands[], externalReference, skipIfBusy }
 *   → 202 { printJobId, status: "PENDING" } (la impresión es asíncrona)
 *
 * La doc dice "same scheme as the Payment API", así que reusamos el MISMO
 * transporte cifrado del cobro (password businessCode+serial, Basic SHA512,
 * body AES-256-CBC en { data }). Si el relay esperara body plano, el error
 * queda logueado con el detalle para ajustar rápido (API en Beta).
 */

type PrintCommand =
  | { type: "text"; text: string; align?: "LEFT" | "CENTER" | "RIGHT"; size?: number; bold?: boolean; italic?: boolean; underline?: boolean }
  | { type: "columns"; columns: Array<{ text: string; weight?: number; align?: "LEFT" | "CENTER" | "RIGHT" }> }
  | { type: "divider"; dividerType?: "SOLID" | "DOTTED" | "EMPTY"; offset?: number }
  | { type: "feed"; lines?: number }
  | { type: "space"; pixels?: number }
  | { type: "cut" }
  | { type: "qr"; content: string; dotSize?: number; errorLevel?: "L" | "M" | "Q" | "H"; align?: "LEFT" | "CENTER" | "RIGHT" };

/** $ 43.890 — sin decimales, agrupado es-CO (la tirilla COP no usa centavos). */
function money(cents: number): string {
  return "$ " + Math.round(cents / 100).toLocaleString("es-CO");
}

/**
 * Tirilla de la factura a partir del snapshot emitido (misma data que la
 * versión imprimible web). Termina con feed + cut como pide la doc.
 */
export function buildInvoiceCommands(
  snapshot: InvoiceSnapshot,
  invoiceNumber: number,
  invoiceUrl: string,
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

  c.push(center(`FACTURA ${formatInvoiceNumber(snapshot, invoiceNumber)}`, 28, true));
  const paidAt = new Date(snapshot.paidAtIso);
  c.push(
    center(
      `${snapshot.tableLabel} · ${snapshot.shortCode} · ` +
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
  for (const it of snapshot.items) {
    c.push({
      type: "columns",
      columns: [
        { text: `${it.qty}x ${it.name}`, weight: 2, align: "LEFT" },
        { text: money(it.priceCents * it.qty), weight: 1, align: "RIGHT" },
      ],
    });
  }
  c.push({ type: "divider", dividerType: "SOLID", offset: 8 });

  c.push({
    type: "columns",
    columns: [
      { text: "Subtotal", weight: 2, align: "LEFT" },
      { text: money(snapshot.subtotalCents), weight: 1, align: "RIGHT" },
    ],
  });
  if (snapshot.tipCents > 0) {
    c.push({
      type: "columns",
      columns: [
        { text: "Propina", weight: 2, align: "LEFT" },
        { text: money(snapshot.tipCents), weight: 1, align: "RIGHT" },
      ],
    });
  }
  c.push({
    type: "columns",
    columns: [
      { text: "TOTAL", weight: 2, align: "LEFT" },
      { text: money(snapshot.totalCents), weight: 1, align: "RIGHT" },
    ],
  });

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

/** Encola la impresión en el datáfono. 202 + PENDING = encolado OK. */
export async function printOnCloudTerminal(args: {
  serialNumber: string;
  commands: PrintCommand[];
  businessCode?: string | null;
  mode?: KushkiMode;
  externalReference?: string;
  printJobId?: string;
}): Promise<PrintJobResult> {
  const businessCode = resolveBusinessCode(args.businessCode);
  const printJobId = args.printJobId ?? randomUUID();
  const payload: Record<string, unknown> = {
    printJobId,
    commands: args.commands,
    skipIfBusy: false,
    ...(args.externalReference
      ? { externalReference: args.externalReference }
      : {}),
  };

  const ts = Math.floor(Date.now() / 1000);
  const password = tokenPassword(businessCode + args.serialNumber, ts);
  const authHash = buildAuthHash(payload, ts, password);
  const encryptedData = encryptPayload(JSON.stringify(payload), ts, password);
  const url =
    terminalBaseUrl(args.mode) +
    `/terminal/v1/${encodeURIComponent(args.serialNumber)}/sync/print/job`;

  console.log("[kushki/cloud-print] job", {
    url,
    serial: args.serialNumber,
    printJobId,
    commands: args.commands.length,
    ts,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
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
    console.error("[kushki/cloud-print] network", err);
    return {
      ok: false,
      printJobId,
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
  // La respuesta puede venir cifrada como en el cobro.
  const dataField =
    json && typeof json === "object"
      ? (json as Record<string, unknown>).data
      : undefined;
  if (typeof dataField === "string" && /^[0-9a-f]+:[0-9a-f]+$/i.test(dataField)) {
    try {
      json = JSON.parse(decryptData(dataField, ts, password));
    } catch {
      /* respuesta plana */
    }
  }
  const obj =
    json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const ok = res.status === 202 || res.status === 200;
  if (!ok) {
    console.error("[kushki/cloud-print] error", {
      httpStatus: res.status,
      body: text.slice(0, 400),
    });
  }
  return {
    ok,
    printJobId,
    status: typeof obj.status === "string" ? obj.status : undefined,
    message: typeof obj.message === "string" ? obj.message : undefined,
    httpStatus: res.status,
    raw: json ?? text,
  };
}
