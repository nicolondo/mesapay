/**
 * Lado del NAVEGADOR de «Este dispositivo» para el usuario Datáfono:
 * pedirle al servidor que imprima en el datáfono por Kushki
 * (`/api/operator/print/terminal`, ver `terminalPrint.ts`) y recordar en el
 * equipo cuál datáfono es éste cuando el comercio tiene varios.
 *
 * Sin APIs nuevas: el datáfono corre Firefox 107 (fetch, JSON y
 * localStorage, nada más).
 */

import { isTerminalBusy, POST_APPROVAL_PRINT_SECONDS } from "@/lib/payments/terminalBusy";
import type { StaffPrintDoc } from "./staffPrint";

export type TerminalPrintDevice = { id: string; label: string };

export type TerminalPrintClientResult =
  | {
      via: "terminal";
      /** `printed`: el datáfono la imprimió. `queued`: todavía no (reintentar con `printJobId`). */
      state: "printed" | "queued";
      printJobId: string;
      deviceId: string;
      deviceLabel: string;
      simulated: boolean;
    }
  | { via: "post_approval"; retryAfterMs: number; deviceId: string; printJobId: string }
  | { via: "printing" }
  | { via: "choose_device"; devices: TerminalPrintDevice[] }
  | { via: "error"; code: string | null; reason?: string; errorCode?: string; printJobId?: string };

type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** El cuerpo que espera la ruta, según el documento. */
export function terminalPrintBody(
  doc: StaffPrintDoc,
  deviceId?: string | null,
  printJobId?: string | null,
): Record<string, string> {
  const base: Record<string, string> =
    doc.kind === "shift" ? { kind: "shift", shiftId: doc.shiftId } : { kind: doc.kind, orderId: doc.orderId };
  if (deviceId) base.deviceId = deviceId;
  if (printJobId) base.printJobId = printJobId;
  return base;
}

export async function printOnTerminal(
  doc: StaffPrintDoc,
  opts: { deviceId?: string | null; printJobId?: string | null; fetch?: FetchLike } = {},
): Promise<TerminalPrintClientResult> {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  let status: number;
  let body: Record<string, unknown> | null = null;
  try {
    const res = await doFetch("/api/operator/print/terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(terminalPrintBody(doc, opts.deviceId, opts.printJobId)),
    });
    status = res.status;
    body = ((await res.json().catch(() => null)) as Record<string, unknown> | null) ?? null;
  } catch {
    return { via: "error", code: "network" };
  }
  if (status >= 200 && status < 300 && body && body.ok === true && typeof body.deviceId === "string") {
    return {
      via: "terminal",
      state: body.state === "queued" ? "queued" : "printed",
      printJobId: typeof body.printJobId === "string" ? body.printJobId : "",
      deviceId: body.deviceId,
      deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel : "",
      simulated: body.simulated === true,
    };
  }
  if (status === 409 && body?.error === "terminal_post_approval" && typeof body.retryAfterMs === "number" && Number.isFinite(body.retryAfterMs)
      && typeof body.deviceId === "string" && typeof body.printJobId === "string") {
    return { via: "post_approval", retryAfterMs: body.retryAfterMs, deviceId: body.deviceId, printJobId: body.printJobId };
  }
  if (status === 409 && body?.error === "terminal_printing") return { via: "printing" };
  if (body?.error === "choose_device" && Array.isArray(body.devices)) {
    const devices = (body.devices as unknown[]).filter(
      (d): d is TerminalPrintDevice =>
        !!d && typeof (d as TerminalPrintDevice).id === "string" && typeof (d as TerminalPrintDevice).label === "string",
    );
    if (devices.length > 0) return { via: "choose_device", devices };
  }
  return {
    via: "error",
    code: typeof body?.error === "string" ? body.error : null,
    ...(typeof body?.reason === "string" && { reason: body.reason }),
    ...(typeof body?.errorCode === "string" && { errorCode: body.errorCode }),
    ...(typeof body?.printJobId === "string" && { printJobId: body.printJobId }),
  };
}

/** Qué decirle a quien imprime cuando el datáfono no recibió la impresión. */
export function terminalPrintMessage(
  code: string | null,
  reason?: string,
  errorCode?: string,
): {
  key:
    | "terminalBusy"
    | "terminalCharging"
    | "terminalStuck"
    | "terminalBackoff"
    | "terminalPostApproval"
    | "terminalNoDevices"
    | "terminalBusinessCode"
    | "terminalKushkiFailed"
    | "terminalClosed"
    | "terminalFailed"
    | "terminalOutOfPaper"
    | "terminalJobFailed";
  values?: { reason: string } | { seconds: number };
} {
  if (isTerminalBusy(errorCode, reason)) return { key: "terminalBusy" };
  // El datáfono la intentó y falló: lo que dijo el equipo.
  if (errorCode) {
    if (/PAPER/i.test(errorCode)) return { key: "terminalOutOfPaper" };
    return { key: "terminalJobFailed", values: { reason: errorCode } };
  }
  switch (code) {
    case "terminal_stuck": return { key: "terminalStuck" };
    case "terminal_print_backoff": return { key: "terminalBackoff" };
    case "terminal_post_approval": return { key: "terminalPostApproval", values: { seconds: POST_APPROVAL_PRINT_SECONDS } };
    case "terminal_charging": return { key: "terminalCharging" };
    case "terminal_busy":
    case "terminal_printing": return { key: "terminalBusy" };
    case "no_devices":
      return { key: "terminalNoDevices" };
    case "cloud_business_code_missing":
      return { key: "terminalBusinessCode" };
    case "print_failed":
      return { key: "terminalKushkiFailed", values: { reason: reason ?? "—" } };
    case "order_closed":
    case "no_items":
    case "no_invoice":
    case "not_found":
      return { key: "terminalClosed" };
    default:
      return { key: "terminalFailed" };
  }
}

/** Clave del almacenamiento local: «este datáfono es: X», por comercio. */
export function printTerminalStorageKey(scope: string | null | undefined): string {
  const s = scope?.trim();
  return `mesapay.imprimir.datafono.${s ? s : "general"}`;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readRememberedPrintTerminal(scope: string | null | undefined): string | null {
  try {
    return storage()?.getItem(printTerminalStorageKey(scope)) ?? null;
  } catch {
    return null;
  }
}

export function rememberPrintTerminal(scope: string | null | undefined, deviceId: string): void {
  try {
    storage()?.setItem(printTerminalStorageKey(scope), deviceId);
  } catch {
    // Sin almacenamiento: la próxima vez se vuelve a elegir.
  }
}
