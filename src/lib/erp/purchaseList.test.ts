import { describe, expect, it } from "vitest";
import {
  hasPurchaseFilters,
  matchesPurchaseSearch,
  matchesStatusFilter,
  pageWindow,
  parsePurchaseListParams,
  parsePurchaseSearch,
  payStatusOf,
  purchaseListHref,
  summarizePurchases,
  tabHref,
  type SummarizablePurchase,
} from "./purchaseList";

const SUPPLIER = "cksupplier00000000000001";

describe("parsePurchaseListParams", () => {
  it("reads every filter from the URL", () => {
    expect(
      parsePurchaseListParams({
        tab: "unpaid",
        q: "  FE-12 ",
        supplier: SUPPLIER,
        status: "overdue",
        from: "2026-10-01",
        to: "2026-10-31",
        page: "3",
      }),
    ).toEqual({ tab: "unpaid", q: "FE-12", supplier: SUPPLIER, status: "overdue", from: "2026-10-01", to: "2026-10-31", page: 3 });
  });

  it("falls back to defaults on anything it does not understand", () => {
    expect(
      parsePurchaseListParams({ tab: "x", status: "overdue", supplier: "a b", from: "2026-02-31", to: "ayer", page: "-2" }),
    ).toEqual({ tab: "orders", q: "", supplier: "", status: "all", from: "", to: "", page: 1 });
  });

  it("only accepts the statuses of the tab, and straightens an inverted range", () => {
    expect(parsePurchaseListParams({ status: "draft", tab: "unpaid" }).status).toBe("all");
    expect(parsePurchaseListParams({ status: "paid" }).status).toBe("paid");
    expect(parsePurchaseListParams({ from: "2026-11-30", to: "2026-11-01" })).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
  });
});

describe("hrefs", () => {
  it("omits the defaults and keeps the filters across tabs (but not status or page)", () => {
    expect(purchaseListHref({})).toBe("/operator/compras");
    const params = parsePurchaseListParams({ q: "fe", supplier: SUPPLIER, status: "draft", from: "2026-11-01", page: "2" });
    expect(purchaseListHref(params)).toBe(`/operator/compras?q=fe&supplier=${SUPPLIER}&status=draft&from=2026-11-01&page=2`);
    expect(tabHref(params, "unpaid")).toBe(`/operator/compras?tab=unpaid&q=fe&supplier=${SUPPLIER}&from=2026-11-01`);
    expect(hasPurchaseFilters(params)).toBe(true);
    expect(hasPurchaseFilters(parsePurchaseListParams({ tab: "unpaid", page: "4" }))).toBe(false);
  });
});

describe("search", () => {
  const po = { number: 12, supplierInvoiceNumber: "FE-000123", supplierName: "Lácteos del Valle", supplierTaxId: "900.123.456-7" };
  const hit = (q: string) => matchesPurchaseSearch(po, parsePurchaseSearch(q));

  it("finds by invoice number however it is written", () => {
    expect(hit("FE 123")).toBe(true);
    expect(hit("fe-0123")).toBe(true);
    expect(hit("123")).toBe(true);
    expect(hit("FE-124")).toBe(false);
  });

  it("finds by purchase number, supplier (accents) and NIT", () => {
    expect(hit("OC-0012")).toBe(true);
    expect(hit("oc12")).toBe(true);
    expect(hit("lacteos")).toBe(true);
    expect(hit("valle")).toBe(true);
    expect(hit("900123456")).toBe(true);
    expect(hit("900.123.456")).toBe(true);
    expect(hit("carnes")).toBe(false);
  });

  it("an empty search matches everything", () => {
    expect(parsePurchaseSearch("   ")).toBeNull();
    expect(matchesPurchaseSearch(po, null)).toBe(true);
  });
});

describe("pay status", () => {
  const today = "2026-11-13";
  it.each([
    [{ status: "draft", outstandingCents: 0, paidCents: 0, dueDate: null }, null],
    [{ status: "canceled", outstandingCents: 0, paidCents: 0, dueDate: null }, null],
    [{ status: "received", outstandingCents: 0, paidCents: 100, dueDate: "2026-11-01" }, "paid"],
    [{ status: "received", outstandingCents: 50, paidCents: 50, dueDate: "2026-11-12" }, "overdue"],
    [{ status: "received", outstandingCents: 50, paidCents: 0, dueDate: "2026-11-13" }, "pending"],
    [{ status: "partially_received", outstandingCents: 50, paidCents: 10, dueDate: null }, "partial"],
  ] as const)("%j → %s", (p, expected) => {
    expect(payStatusOf(p, today)).toBe(expected);
  });

  it("filters by tab and status", () => {
    const overdue = { status: "received" as const, payStatus: "overdue" as const };
    const paid = { status: "received" as const, payStatus: "paid" as const };
    const draft = { status: "draft" as const, payStatus: null };
    expect(matchesStatusFilter(overdue, "unpaid", "all")).toBe(true);
    expect(matchesStatusFilter(paid, "unpaid", "all")).toBe(false);
    expect(matchesStatusFilter(draft, "unpaid", "all")).toBe(false);
    expect(matchesStatusFilter(overdue, "unpaid", "partial")).toBe(false);
    expect(matchesStatusFilter(paid, "orders", "paid")).toBe(true);
    expect(matchesStatusFilter(overdue, "orders", "paid")).toBe(false);
    expect(matchesStatusFilter(draft, "orders", "draft")).toBe(true);
    expect(matchesStatusFilter(draft, "orders", "all")).toBe(true);
  });
});

describe("summarizePurchases", () => {
  it("adds what the filtered list shows: totals, payable and overdue (canceled out of the total)", () => {
    const rows: SummarizablePurchase[] = [
      { status: "received", totalCents: 100_000, outstandingCents: 100_000, payStatus: "overdue" },
      { status: "received", totalCents: 50_000, outstandingCents: 20_000, payStatus: "partial" },
      { status: "received", totalCents: 70_000, outstandingCents: 0, payStatus: "paid" },
      { status: "draft", totalCents: 30_000, outstandingCents: 0, payStatus: null },
      { status: "canceled", totalCents: 999_999, outstandingCents: 0, payStatus: null },
    ];
    expect(summarizePurchases(rows)).toEqual({
      count: 5,
      totalCents: 250_000,
      payableCents: 120_000,
      payableCount: 2,
      overdueCents: 100_000,
      overdueCount: 1,
    });
  });

  it("an empty filter gives zeros", () => {
    expect(summarizePurchases([])).toEqual({ count: 0, totalCents: 0, payableCents: 0, payableCount: 0, overdueCents: 0, overdueCount: 0 });
  });
});

describe("pageWindow", () => {
  it("clamps the page into range", () => {
    expect(pageWindow(1, 0, 25)).toEqual({ page: 1, pageCount: 1, start: 0, end: 0, from: 0, to: 0 });
    expect(pageWindow(2, 60, 25)).toEqual({ page: 2, pageCount: 3, start: 25, end: 50, from: 26, to: 50 });
    expect(pageWindow(9, 60, 25)).toMatchObject({ page: 3, start: 50, end: 60, from: 51, to: 60 });
  });
});
