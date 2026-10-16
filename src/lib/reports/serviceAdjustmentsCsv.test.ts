import { describe, expect, it, vi } from "vitest";
import { formatDate } from "@/lib/format";
import type { ServiceReportRow } from "./serviceAdjustments";
import { serviceReportCsvHeaders, serviceReportCsvRow, streamServiceReportCsv } from "./serviceAdjustmentsCsv";

const options = {
  locale: "en" as const,
  currency: "MXN",
  t: (key: string, values?: Record<string, string | number>) => values ? `${key}:${Object.values(values).join(",")}` : key,
};
const row = (patch: Partial<ServiceReportRow> = {}): ServiceReportRow => ({
  id: "adjustment-1", eventAt: new Date("2026-10-15T02:30:00Z"),
  orderId: "full-order-identifier", shortCode: "ORDER-CODE-2026-000001", tableNumber: 12,
  tableLabel: "Terraza", name: "Nombre histórico", kind: "item_comp", reason: "Motivo original",
  actorEmail: "admin@example.test", quantity: 2, lineCount: 1, amountCents: 123456,
  detailAmountCents: 123456, missingDetail: false, ...patch,
});
async function* rows(...values: ServiceReportRow[]) { yield* values; }

describe("service report CSV rows", () => {
  it("translates headers independently of currency and keeps quantities as units", () => {
    expect(serviceReportCsvHeaders(options)).toEqual([
      "csvDate", "csvOrder", "csvOrderId", "csvTable", "csvProduct", "csvType", "csvQuantity",
      "csvLines", "csvAmount:MXN", "csvDetailAmount:MXN", "csvActor", "csvReason", "csvDetailStatus",
    ]);
    const values = serviceReportCsvRow(row(), options).split(";");
    expect(values).toEqual([
      formatDate(row().eventAt, { locale: "en", timeZone: "America/Bogota", dateStyle: "short", timeStyle: "medium" }),
      "ORDER-CODE-2026-000001", "full-order-identifier", "tableNumber:12 · Terraza", "Nombre histórico", "kindItemComp",
      "2", "1", "1234,56", "1234,56", "admin@example.test", "Motivo original", "detailAvailable",
    ]);
    expect(values[0]).toContain("10/14/26");
    expect(values[0]).toContain("9:30:00");
  });

  it.each([
    ["order_comp", "kindOrderComp"], ["item_comp", "kindItemComp"],
    ["item_cancel", "kindItemCancel"], ["round_cancel", "kindRoundCancel"],
  ] as const)("translates the %s adjustment type", (kind, label) => {
    expect(serviceReportCsvRow(row({ kind }), options)).toContain(`;${label};`);
  });

  it("keeps unavailable snapshots explicit and uses translated missing data labels", () => {
    const csv = serviceReportCsvRow(row({
      kind: "order_comp", shortCode: null, name: null, reason: null, actorEmail: null,
      tableNumber: null, tableLabel: null, amountCents: null, detailAmountCents: 0, missingDetail: true,
    }), options);
    expect(csv).toContain(";full-order-identifier;full-order-identifier;noTable;wholeOrder;");
    expect(csv).toContain(";unknownAmount;0,00;noActor;noReason;missingDetail");
    expect(serviceReportCsvRow(row({ tableLabel: null }), options)).toContain(";tableNumber:12;");
  });

  it.each(["=SUM(A1)", "+cmd", "-cmd", "@SUM(A1)", "\tformula", "\rformula", " =SUM(A1)", "\n=SUM(A1)", "\uFEFF=SUM(A1)"])("neutralizes formula text %j in historical fields", (text) => {
    const csv = serviceReportCsvRow(row({ name: text, reason: text, actorEmail: text, tableLabel: text, shortCode: text }), options);
    expect(csv.match(/'/g)).toHaveLength(4);
    expect(csv).toContain(`tableNumber:12 · ${text}`);
  });

  it("preserves original text including delimiters, quotes, and line breaks", () => {
    const csv = serviceReportCsvRow(row({ name: 'Café; "Especial"', reason: "Primera línea\nSegunda línea" }), options);
    expect(csv).toContain(';"Café; ""Especial""";');
    expect(csv).toContain(';"Primera línea\nSegunda línea";');
  });
});

describe("streamed service report CSV", () => {
  it("exports more than one 500-row batch without truncation and with a UTF-8 BOM", async () => {
    async function* manyRows() {
      for (let index = 0; index < 1001; index++) yield row({ id: `row-${index}`, shortCode: `code-${index}` });
    }
    const response = await streamServiceReportCsv({ ...options, rows: manyRows(), filename: "report.csv" });
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.toString("utf8").slice(1).trimEnd().split("\r\n");
    expect(lines).toHaveLength(1002);
    expect(lines.at(-1)).toContain(";code-1000;");
  });

  it("prefetches one row only and follows consumer backpressure", async () => {
    const next = vi.fn()
      .mockResolvedValueOnce({ value: row(), done: false })
      .mockResolvedValueOnce({ value: row({ id: "row-2" }), done: false });
    const finish = vi.fn().mockResolvedValue({ done: true });
    const iterable = { [Symbol.asyncIterator]: () => ({ next, return: finish }) };
    const response = await streamServiceReportCsv({ ...options, rows: iterable, filename: "report.csv" });
    expect(next).toHaveBeenCalledTimes(1);
    const reader = response.body!.getReader();
    await reader.read(); // Header.
    expect(next).toHaveBeenCalledTimes(1);
    await reader.read(); // Prefetched row.
    expect(next).toHaveBeenCalledTimes(1);
    await reader.read(); // Next row is requested only when consumed.
    expect(next).toHaveBeenCalledTimes(2);
    await reader.cancel();
    expect(finish).toHaveBeenCalledOnce();
  });

  it("returns header-only CSV for no results and sanitizes filenames", async () => {
    const response = await streamServiceReportCsv({ ...options, rows: rows(), filename: 'report"\r\n.csv' });
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="report___.csv"');
    expect((await response.text()).trimEnd().split("\r\n")).toHaveLength(1);
  });

  it("fails before responding when the initial database fetch fails", async () => {
    const failed = { [Symbol.asyncIterator]: () => ({ next: async () => { throw new Error("initial_fetch_failed"); } }) };
    await expect(streamServiceReportCsv({ ...options, rows: failed, filename: "report.csv" })).rejects.toThrow("initial_fetch_failed");
  });

  it("errors the response body when a later batch fails instead of closing a truncated success", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    async function* failsLater() { yield row(); throw new Error("later_fetch_failed"); }
    const response = await streamServiceReportCsv({ ...options, rows: failsLater(), filename: "report.csv" });
    await expect(response.text()).rejects.toThrow("later_fetch_failed");
    expect(logged).toHaveBeenCalledWith("service_report_export_failed", { error: "Error" });
    logged.mockRestore();
  });

  it("stops pulling and closes the iterator when the request aborts", async () => {
    const controller = new AbortController();
    const next = vi.fn().mockResolvedValue({ value: row(), done: false });
    const finish = vi.fn().mockResolvedValue({ done: true });
    const response = await streamServiceReportCsv({
      ...options, rows: { [Symbol.asyncIterator]: () => ({ next, return: finish }) },
      filename: "report.csv", signal: controller.signal,
    });
    controller.abort();
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" });
    expect(next).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  });

  it("does not start database work for an already aborted request", async () => {
    const controller = new AbortController(); controller.abort();
    const next = vi.fn();
    await expect(streamServiceReportCsv({
      ...options, rows: { [Symbol.asyncIterator]: () => ({ next }) }, filename: "report.csv", signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(next).not.toHaveBeenCalled();
  });
});
