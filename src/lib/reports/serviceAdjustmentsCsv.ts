import type { Locale } from "@/i18n/config";
import { CSV_BOM, CSV_CONTENT_TYPE, csvRow } from "@/lib/erp/reports/csv";
import { formatDate } from "@/lib/format";
import type { ServiceAdjustmentKind, ServiceReportRow } from "./serviceAdjustments";

type CsvOptions = {
  locale: Locale;
  currency: string;
  t: (key: string, values?: Record<string, string | number>) => string;
};
const KIND_LABEL: Record<ServiceAdjustmentKind, string> = {
  order_comp: "kindOrderComp", item_comp: "kindItemComp",
  item_cancel: "kindItemCancel", round_cancel: "kindRoundCancel",
};

export function serviceReportCsvHeaders({ t, currency }: CsvOptions): string[] {
  return [
    t("csvDate"), t("csvOrder"), t("csvOrderId"), t("csvTable"), t("csvProduct"), t("csvType"),
    t("csvQuantity"), t("csvLines"), t("csvAmount", { currency }), t("csvDetailAmount", { currency }),
    t("csvActor"), t("csvReason"), t("csvDetailStatus"),
  ];
}

export function serviceReportCsvRow(row: ServiceReportRow, { t, locale }: CsvOptions): string {
  const table = row.tableNumber === null ? t("noTable") : t("tableNumber", { number: row.tableNumber });
  const values = [
    formatDate(row.eventAt, { locale, timeZone: "America/Bogota", dateStyle: "short", timeStyle: "medium" }),
    row.shortCode ?? row.orderId,
    row.orderId,
    row.tableLabel ? `${table} · ${row.tableLabel}` : table,
    row.name ?? t("wholeOrder"),
    t(KIND_LABEL[row.kind]),
    // The shared CSV dialect interprets numbers as cents, so counts are strings.
    String(row.quantity), String(row.lineCount),
    row.amountCents ?? t("unknownAmount"), row.detailAmountCents,
    row.actorEmail ?? t("noActor"), row.reason ?? t("noReason"),
    t(row.missingDetail ? "missingDetail" : "detailAvailable"),
  ];
  // Spreadsheet importers can trim whitespace before evaluating a formula.
  // The shared encoder already protects formula markers in the first position.
  return csvRow(values.map(value => typeof value === "string" && /^\s+[=+\-@]/u.test(value) ? `'${value}` : value));
}

function logExportFailure(error: unknown): void {
  console.error("service_report_export_failed", { error: error instanceof Error ? error.name : "unknown" });
}

/**
 * Prefetch before sending headers so an initial query failure remains an HTTP
 * error. Later failures error the body; closing it would silently accept a
 * truncated export. Pulling one row at a time retains the query's batch bound.
 */
export async function streamServiceReportCsv({
  rows, filename, signal, ...options
}: CsvOptions & {
  rows: AsyncIterable<ServiceReportRow>;
  filename: string;
  signal?: AbortSignal;
}): Promise<Response> {
  signal?.throwIfAborted();
  const iterator = rows[Symbol.asyncIterator]();
  let pending: IteratorResult<ServiceReportRow> | null;
  try {
    pending = await iterator.next();
    signal?.throwIfAborted();
  } catch (error) {
    try { await iterator.return?.(); } catch (cleanupError) { logExportFailure(cleanupError); }
    throw error;
  }

  const encoder = new TextEncoder();
  let stopped = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closing: Promise<unknown> | undefined;
  const finish = () => {
    stopped = true;
    signal?.removeEventListener("abort", abort);
  };
  const closeIterator = () => closing ??= Promise.resolve().then(() => iterator.return?.());
  const abort = () => {
    if (stopped) return;
    finish();
    controller.error(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    void closeIterator().catch(logExportFailure);
  };
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      controller.enqueue(encoder.encode(`${CSV_BOM}${csvRow(serviceReportCsvHeaders(options))}\r\n`));
      if (pending?.done) { finish(); controller.close(); }
    },
    async pull() {
      if (stopped) return;
      try {
        const next = pending ?? await iterator.next();
        pending = null;
        if (stopped) return;
        if (next.done) { finish(); controller.close(); return; }
        controller.enqueue(encoder.encode(`${serviceReportCsvRow(next.value, options)}\r\n`));
      } catch (error) {
        if (stopped) return;
        finish();
        logExportFailure(error);
        controller.error(error);
        try { await closeIterator(); } catch (cleanupError) { logExportFailure(cleanupError); }
      }
    },
    async cancel() {
      finish();
      await closeIterator();
    },
  }, { highWaterMark: 0 });

  return new Response(body, {
    headers: {
      "Content-Type": CSV_CONTENT_TYPE,
      "Content-Disposition": `attachment; filename="${filename.replace(/["\r\n]/g, "_")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
