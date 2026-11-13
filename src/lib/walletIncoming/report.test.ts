import { beforeEach, describe, expect, it, vi } from "vitest";
import { decimalCents, readSettlementReport, settlementPeriod } from "./report";

const fetcher = vi.fn();
const now = new Date("2026-11-09T23:30:00.000Z");
const period = () => settlementPeriod(now);
const row = (extra: Record<string, unknown> = {}) => ({
  ticket_number: "ticket-1", merchant_id: "merchant-fixture", currency_code: "COP",
  created: "2026-11-06", payment_date: "2026-11-11", transaction_status: "APPROVED",
  transaction_type: "SALE", approved_transaction_amount: "15000.00", pay_amount: "14682.00",
  wallet: "0.00", buy_order: "never-a-match", ...extra,
});
const page = (rows: unknown[], p = 1, total = rows.length, pages = 1) => ({ data: rows, pagination: { page: p, limit: 100, total, totalPages: pages } });
const read = () => readSettlementReport({ mode: "production", privateKey: "fixture-private", period: period() });
beforeEach(() => { vi.stubGlobal("fetch", fetcher); fetcher.mockReset(); });

describe("settlement report boundary", () => {
  it("uses seven complete Bogota days and includes today only in the local interval", () => {
    expect(period()).toEqual({ startDate: "2026-11-02", endDate: "2026-11-08", periodStart: "2026-11-02T05:00:00.000Z", periodEnd: now.toISOString() });
    expect(settlementPeriod(new Date("2026-11-09T03:00:00Z"))).toMatchObject({ startDate: "2026-11-01", endDate: "2026-11-07" });
    expect(settlementPeriod(new Date("2026-01-01T12:00:00Z"))).toMatchObject({ startDate: "2025-12-25", endDate: "2025-12-31" });
  });
  it.each([["0", 0], ["14682.30", 1468230], ["-3.00", -300], ["90071992547409.91", Number.MAX_SAFE_INTEGER]])("parses decimal money exactly: %s", (value, expected) => {
    expect(decimalCents(value)).toBe(expected);
  });
  it.each(["1e3", "1,000.00", "1.234", "90071992547409.92", "NaN", " 1 ", 123, ""]) ("rejects unsafe money %s", value => {
    expect(() => decimalCents(value)).toThrow();
  });
  it("reads the verified shape and retains a future payment date without a credited status", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(page([row()]))));
    const report = await read();
    expect(report).toMatchObject({ status: "available", complete: true, rows: [{ reference: "ticket-1", eligible: true, grossCents: 1500000, netCents: 1468200, paymentDate: "2026-11-11", currency: "COP" }] });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.kushkipagos.com/merchant-settlement/v1/settlement?switch=ecommerce");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ startDate: "2026-11-02", endDate: "2026-11-08", page: 1, limit: 100 });
    expect(init.headers["Private-Merchant-Id"]).toBe("fixture-private");
    expect(JSON.stringify(report)).not.toMatch(/merchant-fixture|never-a-match|credited|fixture-private/);
  });
  it("keeps non-sale and zero-value adjustment rows non-matchable rather than inventing application receipts", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(page([row({ approved_transaction_amount: "0.00", pay_amount: "-3.00", transaction_type: "ADJUSTMENT" })]))));
    expect((await read()).rows[0]).toMatchObject({ grossCents: 0, netCents: -300, eligible: false });
  });
  it("requests subsequent pages and refuses inconsistent pagination", async () => {
    const first = Array.from({ length: 100 }, (_, i) => row({ ticket_number: `ticket-${i}` }));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(page(first, 1, 101, 2))))
      .mockResolvedValueOnce(new Response(JSON.stringify(page([row({ ticket_number: "ticket-last" })], 2, 101, 2))));
    expect(await read()).toMatchObject({ complete: true, rows: expect.any(Array) });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).page).toBe(2);
    fetcher.mockResolvedValue(new Response(JSON.stringify(page([row()], 2))));
    expect(await read()).toMatchObject({ status: "unavailable", complete: false, rows: [] });
  });
  it("does not call a partial report complete when a later page fails", async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(page(Array.from({ length: 100 }, (_, i) => row({ ticket_number: String(i) })), 1, 101, 2))))
      .mockRejectedValueOnce(new Error("private provider detail"));
    const result = await read();
    expect(result).toEqual({ status: "unavailable", rows: [], complete: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("bounds pagination and marks capped reports incomplete", async () => {
    fetcher.mockImplementation((_url, init) => {
      const p = JSON.parse(init.body).page;
      return Promise.resolve(new Response(JSON.stringify(page(Array.from({ length: 100 }, (_, i) => row({ ticket_number: `${p}-${i}` })), p, 1000, 10))));
    });
    const result = await read();
    expect(result).toMatchObject({ status: "available", complete: false });
    expect(result.rows).toHaveLength(500);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
  it.each([{}, page([row({ payment_date: "2026-02-30" })]), page([row({ ticket_number: "" })]), page([row({ merchant_id: "" })]), page([row({ currency_code: "" })]), page([row({ approved_transaction_amount: "1.001" })]), page([row({ merchant_id: "first" }), row({ merchant_id: "other" })])])("fails closed for a malformed report", async payload => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(payload)));
    expect(await read()).toEqual({ status: "unavailable", rows: [], complete: false });
  });
  it.each([[403, "permission_required"], [401, "credentials_missing"], [500, "unavailable"]])("sanitizes HTTP %s and never retries it", async (code, status) => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ code: "E003", message: "secret error detail" }), { status: code }));
    expect(await read()).toEqual({ status, rows: [], complete: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not label an unknown 403 as missing settlement permission", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ message: "Missing Authentication Token" }), { status: 403 }));
    expect(await read()).toEqual({ status: "unavailable", rows: [], complete: false });
  });
  it("rejects an oversized or empty response body", async () => {
    fetcher.mockResolvedValueOnce(new Response("x".repeat(1_048_577))).mockResolvedValueOnce(new Response(null));
    expect(await read()).toEqual({ status: "unavailable", rows: [], complete: false });
    expect(await read()).toEqual({ status: "unavailable", rows: [], complete: false });
  });
  it("does not start another page after the shared request budget expires", async () => {
    fetcher.mockResolvedValue(new Response(JSON.stringify(page(Array.from({ length: 100 }, (_, i) => row({ ticket_number: String(i) })), 1, 101, 2))));
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1000).mockReturnValue(31001);
    try {
      expect(await read()).toEqual({ status: "unavailable", rows: [], complete: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
});
