/**
 * La TIRILLA del cierre de turno, del lado del servidor: armarla con los
 * textos y los datos del turno (`loadShiftCloseTicket`) y encolarla en la
 * impresora de caja (`enqueueShiftCloseTicket`).
 *
 * La impresora es la MISMA de la factura y la precuenta (la elegida en
 * Configuración, o las de tipo factura): es la de la caja, donde se hace
 * el arqueo. Mismas reglas que `prebillQueue.ts`: sin impresora de
 * facturas no se encola nada y se dice (`no_printer`); con el agente
 * caído tampoco (`agent_offline`), para no dejar un papel que saldría a
 * destiempo. Quien llama imprime entonces la vista del navegador.
 *
 * El idioma es el de quien la pide (el cierre es un papel interno, como la
 * pantalla del turno): `getTranslations` del request.
 */

import { getTranslations } from "next-intl/server";
import { db } from "@/lib/db";
import { fmtCOP } from "@/lib/format";
import { fmtBogotaDateTime, shiftBusinessDateIso } from "@/lib/bogota";
import { buildShiftReport, PAYMENT_METHOD_LABEL } from "@/lib/shiftReport";
import {
  REPORT_PAYLOAD_VERSION,
  SHIFT_CLOSE_JOB_KIND,
  type ReportPrintJobPayload,
  type ThermalReport,
} from "@/lib/escpos/report";
import { buildShiftCloseTicket, SHIFT_METHOD_KEY, shiftDurationLabel } from "./shiftCloseDoc";
import { invoicePrinterWhere, isInvoicePrinter, printerReachable } from "./routing";

export type LoadShiftCloseResult =
  | { ok: true; doc: ThermalReport; paperMm: number }
  | { ok: false; reason: "not_found" };

/**
 * El documento del cierre de un turno de ESTE comercio. El ancho:
 *   - `devicePaperMm` («Este dispositivo»): ése, tal cual (40–120 mm);
 *   - si no, `paperWidthMm` (la impresora del agente) o el papel del
 *     comercio, llevados a 58 u 80 como siempre.
 * Un turno de otro comercio es `not_found`.
 */
export async function loadShiftCloseTicket(args: {
  shiftId: string;
  restaurantId: string;
  paperWidthMm?: number | null;
  devicePaperMm?: number | null;
}): Promise<LoadShiftCloseResult> {
  const report = await buildShiftReport(args.shiftId);
  if (!report || report.shift.restaurantId !== args.restaurantId) {
    return { ok: false, reason: "not_found" };
  }
  const tenant = await db.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: {
      name: true,
      legalName: true,
      taxId: true,
      businessDayCutoffHour: true,
      printPaperWidthMm: true,
    },
  });
  const t = await getTranslations("opShifts");
  const tTips = await getTranslations("tipReturns");
  const tr = (key: string, values?: Record<string, string | number>) =>
    t(key as Parameters<typeof t>[0], values as never) as string;
  const trTips = (key: string, values?: Record<string, string | number>) =>
    tTips(key as Parameters<typeof tTips>[0], values as never) as string;

  const paperMm: number =
    args.devicePaperMm ??
    ((args.paperWidthMm ?? tenant?.printPaperWidthMm ?? 80) <= 58 ? 58 : 80);
  const durationMs = report.shift.closedAt
    ? report.shift.closedAt.getTime() - report.shift.openedAt.getTime()
    : 0;
  const now = fmtBogotaDateTime(new Date());

  const doc = buildShiftCloseTicket({
    report,
    paperWidthMm: paperMm,
    merchant: tenant?.legalName?.trim() || tenant?.name || tr("merchantFallback"),
    taxId: tenant?.taxId ?? null,
    businessDate: shiftBusinessDateIso(report.shift, tenant?.businessDayCutoffHour ?? 0),
    dateTime: (d) => {
      const f = fmtBogotaDateTime(d);
      return tr("dateTime", { date: f.date, time: f.time });
    },
    durationLabel: shiftDurationLabel(durationMs, tr),
    generatedLabel: tr("reportGenerated", { date: now.date, time: now.time }),
    money: fmtCOP,
    methodLabel: (method) =>
      SHIFT_METHOD_KEY[method]
        ? tr(SHIFT_METHOD_KEY[method])
        : (PAYMENT_METHOD_LABEL[method as keyof typeof PAYMENT_METHOD_LABEL] ?? method),
    t: tr,
    tTips: trTips,
  });
  return { ok: true, doc, paperMm };
}

export type EnqueueShiftCloseResult =
  | { queued: true; printerName: string; jobs: number }
  | { queued: false; reason: "not_found" | "no_printer" | "agent_offline" };

/** Encola la tirilla del cierre en la impresora de caja cuyo agente responde. */
export async function enqueueShiftCloseTicket(args: {
  restaurantId: string;
  shiftId: string;
  /** Quién la pidió: sólo para el log. */
  requestedByUserId: string;
}): Promise<EnqueueShiftCloseResult> {
  const { restaurantId, shiftId } = args;
  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { invoicePrinterId: true },
  });
  const chosenId = restaurant?.invoicePrinterId ?? null;
  const printers = await db.printer.findMany({
    where: invoicePrinterWhere(restaurantId, chosenId),
    select: {
      id: true,
      kind: true,
      label: true,
      paperWidthMm: true,
      agent: { select: { lastSeenAt: true, revokedAt: true, deletedAt: true } },
    },
  });
  const targets = printers.filter((p) => (chosenId ? p.id === chosenId : isInvoicePrinter(p)));
  if (targets.length === 0) return { queued: false, reason: "no_printer" };
  const now = new Date();
  const reachable = targets.filter((p) => printerReachable(p.agent, now));
  if (reachable.length === 0) return { queued: false, reason: "agent_offline" };

  const rows = [];
  for (const printer of reachable) {
    const loaded = await loadShiftCloseTicket({
      shiftId,
      restaurantId,
      paperWidthMm: printer.paperWidthMm,
    });
    if (!loaded.ok) return { queued: false, reason: "not_found" };
    const payload: ReportPrintJobPayload = { v: REPORT_PAYLOAD_VERSION, report: loaded.doc };
    rows.push({
      restaurantId,
      printerId: printer.id,
      kind: SHIFT_CLOSE_JOB_KIND,
      payload: payload as unknown as object,
      // Reimprimir el cierre a propósito está permitido.
      dedupeKey: null,
    });
  }
  const created = await db.printJob.createMany({ data: rows });
  const printerName = reachable.map((p) => p.label).join(" · ");
  console.log("[print-queue] cierre de turno encolado", {
    restaurantId,
    shiftId,
    requestedByUserId: args.requestedByUserId,
    jobs: created.count,
    printerName,
  });
  return { queued: true, printerName, jobs: created.count };
}
