/**
 * «Este dispositivo» para el usuario DATÁFONO: imprimir en la impresora
 * integrada del Smart POS de Kushki (Sunmi P3) por el Print API CLOUD de
 * Kushki, del lado del servidor.
 *
 * Por qué no el diálogo de impresión del navegador: el datáfono corre
 * MESAPAY como app instalada (PWA) en Firefox para Android 107. Firefox para
 * Android recién imprime con `window.print()` desde la versión 114 (notas de
 * versión de Mozilla, 114.0: «Websites that use window.print() can now be
 * printed»), y el menú «Imprimir» del navegador llegó en la 118 — que además
 * no existe en una app instalada. Ahí `window.print()` existe pero no hace
 * nada. El Print API de Kushki, en cambio, le habla al equipo directamente.
 *
 * El contenido es el MISMO que el de la impresora de caja: se arma el
 * documento térmico de siempre (factura/comprobante, precuenta o cierre) y
 * se pasa a comandos (`terminalCommands.ts`).
 *
 * ¿A cuál datáfono? En este orden:
 *   1. el que este equipo recuerda («este datáfono es: X», `deviceId`);
 *   2. el único del comercio, si hay uno solo;
 *   3. si hay varios, `choose_device` con la lista: se elige una vez.
 * No se mira a quién está "asignado" el datáfono: los datáfonos son del
 * COMERCIO, no de una persona (`terminalNotAssigned.test.ts`).
 *
 * En modo `mock` (sin Business-Code) NO se llama a Kushki: se simula el
 * envío (`simulated: true`), igual que el cobro mock. En producción el mock
 * no imprime (`mock_print_disabled`).
 */

import { randomUUID } from "node:crypto";
import { refreshPreviousPrint, reservePrint, releasePrint, recordPrintFault } from "@/lib/payments/terminalPrinterLock";
import { isTerminalBusy } from "@/lib/payments/terminalBusy";
import { db } from "@/lib/db";
import { getCurrencyForCountry } from "@/lib/billing/countries";
import { isModuleEnabled } from "@/lib/modules";
import { dianEnvironment } from "@/lib/dian/config";
import { dianQrUrl } from "@/lib/dian/crypto";
import { kushkiTerminalSetup, terminalDeviceUsable } from "@/lib/payments/terminalAvailability";
import {
  printOnCloudTerminal,
  waitForCloudPrintJob,
  type CloudPrintOutcome,
  type PrintCommand,
  type PrintJobResult,
} from "@/lib/payments/kushki/cloudPrint";
import type { KushkiMode } from "@/lib/platformConfig";
import { buildInvoiceDocument } from "./invoiceQueue";
import { loadInvoicePaymentDetails } from "./invoicePayments";
import { invoicePrintArgs, type InvoiceDianPrintData } from "./routing";
import { loadPrebill } from "./prebillData";
import { buildPrebillDocument } from "./prebillQueue";
import { loadShiftCloseTicket } from "./shiftCloseQueue";
import {
  invoiceToTerminalCommands,
  prebillToTerminalCommands,
  reportToTerminalCommands,
} from "./terminalCommands";

/** El papel del datáfono: 58 mm (32 columnas en los documentos térmicos). */
const TERMINAL_DOC_PAPER_MM = 58;

export type TerminalPrintTarget =
  | { kind: "invoice"; orderId: string }
  | { kind: "prebill"; orderId: string }
  | { kind: "shift"; shiftId: string };

export type TerminalPrintError =
  | "not_found"
  | "no_invoice"
  | "order_closed"
  | "no_items"
  | "no_devices"
  | "choose_device"
  | "cloud_business_code_missing"
  | "mock_print_disabled"
  | "terminal_charging"
  | "terminal_printing"
  | "terminal_busy"
  | "terminal_stuck"
  | "terminal_print_backoff"
  | "terminal_post_approval"
  | "print_failed";

export type TerminalPrintResult =
  | {
      ok: true;
      deviceId: string;
      deviceLabel: string;
      printJobId: string;
      /**
       * `printed`: el datáfono respondió COMPLETED. `queued`: Kushki la
       * encoló pero el datáfono todavía no la imprime (se reintenta con el
       * mismo `printJobId`, sin duplicar).
       */
      state: "printed" | "queued";
      /** Modo mock: no se llamó a Kushki. */
      simulated: boolean;
      /** Para el rastro: qué se imprimió ("factura FE-12", "precuenta A4F2"). */
      reference: string;
    }
  | {
      ok: false;
      error: TerminalPrintError;
      devices?: Array<{ id: string; label: string }>;
      /** Detalle de Kushki (timeout, network_error, http_400…). */
      reason?: string;
      /** El datáfono la intentó y falló: el código de Kushki (OUT_OF_PAPER…). */
      errorCode?: string;
      errorMessage?: string;
      printJobId?: string;
    };

type BuiltCommands =
  | { ok: true; commands: PrintCommand[]; reference: string; externalReference: string }
  | { ok: false; error: "not_found" | "no_invoice" | "order_closed" | "no_items" };

/** Arma los comandos del documento (el mismo contenido de la caja). */
export async function buildTerminalCommands(
  restaurantId: string,
  target: TerminalPrintTarget,
): Promise<BuiltCommands> {
  if (target.kind === "prebill") {
    const loaded = await loadPrebill({ restaurantId, orderId: target.orderId });
    if (!loaded.ok) return { ok: false, error: loaded.reason };
    const doc = await buildPrebillDocument({
      data: loaded.data,
      paperWidthMm: TERMINAL_DOC_PAPER_MM,
      currency: loaded.currency,
      locale: loaded.locale,
    });
    return {
      ok: true,
      commands: prebillToTerminalCommands(doc),
      reference: `precuenta ${loaded.data.shortCode}`,
      externalReference: `prebill-${target.orderId}`,
    };
  }

  if (target.kind === "shift") {
    const loaded = await loadShiftCloseTicket({
      shiftId: target.shiftId,
      restaurantId,
      devicePaperMm: TERMINAL_DOC_PAPER_MM,
    });
    if (!loaded.ok) return { ok: false, error: "not_found" };
    return {
      ok: true,
      commands: reportToTerminalCommands(loaded.doc),
      reference: "cierre de turno",
      externalReference: `shift-${target.shiftId}`,
    };
  }

  const invoice = await db.simpleInvoice.findUnique({
    where: { orderId: target.orderId },
    select: {
      id: true,
      restaurantId: true,
      orderId: true,
      invoiceNumber: true,
      snapshot: true,
      order: { select: { locale: true } },
      dianDocument: { select: { state: true, cufe: true } },
      restaurant: { select: { enabledModules: true, country: true } },
    },
  });
  if (!invoice || invoice.restaurantId !== restaurantId) return { ok: false, error: "no_invoice" };
  const args = invoicePrintArgs(invoice, invoice.order);
  // Con DETALLE (tarjeta, vuelto, referencia…): es lo que arma la sección
  // «Pagos» del documento — la misma de la tirilla de la caja.
  const payments = await loadInvoicePaymentDetails(invoice.orderId);
  const doc = await buildInvoiceDocument({
    snapshot: args.snapshot,
    invoiceNumber: args.invoiceNumber,
    paperWidthMm: TERMINAL_DOC_PAPER_MM,
    currency: await getCurrencyForCountry(invoice.restaurant.country),
    payments,
    paymentDetails: payments,
    locale: args.locale,
    dian: await dianPrintDataFor(invoice, restaurantId),
    supportsQr: true,
  });
  return {
    ok: true,
    commands: invoiceToTerminalCommands(doc),
    reference: `factura ${doc.documentNumber}`,
    externalReference: `invoice-${invoice.invoiceNumber}`,
  };
}

/** CUFE + QR sólo con facturación electrónica y la factura ACEPTADA. */
async function dianPrintDataFor(
  invoice: {
    restaurant: { enabledModules: unknown };
    dianDocument: { state: string; cufe: string | null } | null;
  },
  restaurantId: string,
): Promise<InvoiceDianPrintData | null> {
  if (!isModuleEnabled(invoice.restaurant.enabledModules, "einvoicing")) return null;
  const doc = invoice.dianDocument;
  if (!doc || doc.state !== "accepted" || !doc.cufe) return null;
  const environment = await dianEnvironment(restaurantId);
  return { cufe: doc.cufe, qrUrl: dianQrUrl(doc.cufe, environment === "produccion" ? "1" : "2") };
}

type DeviceRow = {
  kushkiDeviceId: string;
  label: string;
  serialNumber: string | null;
  active: boolean;
};

/** El datáfono al que va la impresión (ver el orden en el encabezado). */
export function chooseTerminalDevice(
  devices: readonly DeviceRow[],
  { deviceId }: { deviceId?: string | null },
): { ok: true; device: DeviceRow } | { ok: false; error: "no_devices" | "choose_device" } {
  if (devices.length === 0) return { ok: false, error: "no_devices" };
  const remembered = deviceId ? devices.find((d) => d.kushkiDeviceId === deviceId) : undefined;
  if (remembered) return { ok: true, device: remembered };
  if (devices.length === 1) return { ok: true, device: devices[0] };
  return { ok: false, error: "choose_device" };
}

/**
 * Los datáfonos a los que se puede mandar una impresión AHORA (para mostrar
 * «Datáfono» en «Imprimir en» y elegir cuál): activos y, con datáfono real,
 * con serial; ninguno si falta el Business-Code o si es el mock en
 * producción.
 */
export async function listTerminalPrintDevices(
  restaurantId: string,
  opts: { isProduction?: boolean } = {},
): Promise<Array<{ id: string; label: string }>> {
  const tenant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, kushkiMode: true, cloudTerminalBusinessCode: true },
  });
  if (!tenant) return [];
  const { businessCode, useRealTerminal } = await kushkiTerminalSetup(tenant);
  if (useRealTerminal && !businessCode) return [];
  const isProduction = opts.isProduction ?? process.env.NODE_ENV === "production";
  if (!useRealTerminal && isProduction) return [];
  const rows = await db.terminalDevice.findMany({
    where: { restaurantId: tenant.id, active: true },
    orderBy: { createdAt: "asc" },
    select: { kushkiDeviceId: true, label: true, serialNumber: true, active: true },
  });
  return rows
    .filter((d) => terminalDeviceUsable(d, useRealTerminal))
    .map((d) => ({ id: d.kushkiDeviceId, label: d.label }));
}

export type TerminalPrintDeps = {
  send?: (args: Parameters<typeof printOnCloudTerminal>[0]) => Promise<PrintJobResult>;
  /** Sondeo del estado real (`/sync/print_job`) hasta ~30 s. */
  waitJob?: (args: Parameters<typeof waitForCloudPrintJob>[0]) => Promise<CloudPrintOutcome>;
  /** Para los tests: `process.env.NODE_ENV === "production"`. */
  isProduction?: boolean;
};

/** Imprime el documento en el datáfono (o lo simula en modo mock). */
export async function printOnTerminalDevice(
  args: {
    restaurantId: string;
    userId: string;
    target: TerminalPrintTarget;
    deviceId?: string | null;
    /** Reintento de un trabajo que quedó encolado: el MISMO id (no duplica). */
    printJobId?: string | null;
  },
  deps: TerminalPrintDeps = {},
): Promise<TerminalPrintResult> {
  const tenant = await db.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: { id: true, kushkiMode: true, cloudTerminalBusinessCode: true },
  });
  if (!tenant) return { ok: false, error: "not_found" };
  const { mode, businessCode, useRealTerminal } = await kushkiTerminalSetup(tenant);
  if (useRealTerminal && !businessCode) return { ok: false, error: "cloud_business_code_missing" };
  const isProduction = deps.isProduction ?? process.env.NODE_ENV === "production";
  if (!useRealTerminal && isProduction) return { ok: false, error: "mock_print_disabled" };

  const rows = await db.terminalDevice.findMany({
    where: { restaurantId: tenant.id, active: true },
    orderBy: { createdAt: "asc" },
    select: { kushkiDeviceId: true, label: true, serialNumber: true, active: true },
  });
  const usable = rows.filter((d) => terminalDeviceUsable(d, useRealTerminal));
  const chosen = chooseTerminalDevice(usable, { deviceId: args.deviceId });
  if (!chosen.ok) {
    return {
      ok: false,
      error: chosen.error,
      ...(chosen.error === "choose_device" && {
        devices: usable.map((d) => ({ id: d.kushkiDeviceId, label: d.label })),
      }),
    };
  }
  const device = chosen.device;

  const built = await buildTerminalCommands(tenant.id, args.target);
  if (!built.ok) return { ok: false, error: built.error };

  const jobId = args.printJobId ?? randomUUID();
  await refreshPreviousPrint(device, { mode, businessCode, useRealTerminal });
  const reservedAt = new Date();
  const conflict = await reservePrint(device, jobId, reservedAt);
  if (conflict === "already_queued") {
    return {
      ok: true, deviceId: device.kushkiDeviceId, deviceLabel: device.label,
      printJobId: jobId, state: "queued", simulated: !useRealTerminal, reference: built.reference,
    };
  }
  if (conflict) return { ok: false, error: conflict };

  if (!useRealTerminal) {
    await releasePrint(device, jobId, reservedAt);
    console.log("[kushki/cloud-print] mock: impresión simulada", {
      restaurantId: tenant.id,
      device: device.kushkiDeviceId,
      commands: built.commands.length,
      reference: built.externalReference,
    });
    return {
      ok: true,
      deviceId: device.kushkiDeviceId,
      deviceLabel: device.label,
      printJobId: jobId,
      state: "printed",
      simulated: true,
      reference: built.reference,
    };
  }

  const target = { serialNumber: device.serialNumber!, businessCode, mode: mode as KushkiMode };
  const send = deps.send ?? printOnCloudTerminal;
  const result = await send({
    ...target,
    commands: built.commands,
    externalReference: built.externalReference,
    printJobId: jobId,
  });
  if (!result.ok) {
    // A transport failure may have enqueued the job. Keep its reservation.
    const busy = isTerminalBusy(result.errorCode, result.message);
    const unconfirmed = !result.httpStatus || result.httpStatus >= 500 || result.httpStatus === 408;
    if (busy || unconfirmed) {
      const fault = unconfirmed ? "timeout" : "busy";
      await recordPrintFault(device, jobId, reservedAt, fault);
      return { ok: false, error: "terminal_print_backoff", ...(fault === "timeout" && { printJobId: jobId }) };
    }
    if (result.httpStatus && [400, 401, 403, 404, 409, 422].includes(result.httpStatus)) {
      await releasePrint(device, jobId, reservedAt);
    }
    return {
      ok: false,
      error: "print_failed",
      reason: result.message ?? (result.httpStatus ? `http_${result.httpStatus}` : "unknown"),
      printJobId: result.printJobId,
    };
  }
  // 202 = encolado, NO impreso: el estado real se pregunta hasta ~30 s.
  const outcome = await (deps.waitJob ?? waitForCloudPrintJob)({ ...target, printJobId: result.printJobId });
  if (outcome.state === "failed" && isTerminalBusy(outcome.errorCode, outcome.errorMessage)) {
    await recordPrintFault(device, jobId, reservedAt, "busy");
    return { ok: false, error: "terminal_print_backoff" };
  }
  if (outcome.state === "pending") {
    await recordPrintFault(device, jobId, reservedAt, "unconfirmed");
    if (outcome.backoff) return { ok: false, error: "terminal_print_backoff", printJobId: jobId };
  } else {
    await releasePrint(device, jobId, reservedAt);
  }
  if (outcome.state === "failed") {
    return {
      ok: false,
      error: "print_failed",
      reason: outcome.errorCode ?? "FAILED",
      ...(outcome.errorCode && { errorCode: outcome.errorCode }),
      ...(outcome.errorMessage && { errorMessage: outcome.errorMessage }),
      printJobId: result.printJobId,
    };
  }
  return {
    ok: true,
    deviceId: device.kushkiDeviceId,
    deviceLabel: device.label,
    printJobId: result.printJobId,
    state: outcome.state === "completed" ? "printed" : "queued",
    simulated: false,
    reference: built.reference,
  };
}
