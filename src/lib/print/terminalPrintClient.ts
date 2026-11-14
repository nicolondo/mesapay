/**
 * Lado del NAVEGADOR de «Este dispositivo» para el usuario Datáfono:
 * pedirle al servidor que imprima en el datáfono por Kushki
 * (`/api/operator/print/terminal`, ver `terminalPrint.ts`) y recordar en el
 * equipo cuál datáfono es éste cuando el comercio tiene varios.
 *
 * Sin APIs nuevas: el datáfono corre Firefox 107 (fetch, JSON y
 * localStorage, nada más).
 */

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
  | { via: "choose_device"; devices: TerminalPrintDevice[] }
  | { via: "error"; code: string | null; reason?: string; errorCode?: string; printJobId?: string };

type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

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
  let ok = false;
  let body: Record<string, unknown> | null = null;
  try {
    const res = await doFetch("/api/operator/print/terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(terminalPrintBody(doc, opts.deviceId, opts.printJobId)),
    });
    ok = res.ok;
    body = ((await res.json().catch(() => null)) as Record<string, unknown> | null) ?? null;
  } catch {
    return { via: "error", code: "network" };
  }
  if (ok && body && body.ok === true && typeof body.deviceId === "string") {
    return {
      via: "terminal",
      state: body.state === "queued" ? "queued" : "printed",
      printJobId: typeof body.printJobId === "string" ? body.printJobId : "",
      deviceId: body.deviceId,
      deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel : "",
      simulated: body.simulated === true,
    };
  }
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
    | "terminalNoDevices"
    | "terminalBusinessCode"
    | "terminalKushkiFailed"
    | "terminalClosed"
    | "terminalFailed"
    | "terminalOutOfPaper"
    | "terminalJobFailed";
  values?: { reason: string };
} {
  // El datáfono la intentó y falló: lo que dijo el equipo.
  if (errorCode) {
    if (/PAPER/i.test(errorCode)) return { key: "terminalOutOfPaper" };
    return { key: "terminalJobFailed", values: { reason: errorCode } };
  }
  switch (code) {
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
