import { describe, expect, it } from "vitest";
import {
  CUSTOMER_PAGE_SIZE,
  DEFAULT_CUSTOMER_LIST_PARAMS,
  customerListHref,
  customerListQuery,
  docTypesForFilter,
  escapeLike,
  hasCustomerFilters,
  isChargeOverdue,
  normalizeCustomerSearch,
  overdueFromTotals,
  pageWindow,
  parseCustomerListParams,
  parsePageSize,
  summaryFromAggregate,
} from "./billingCustomerList";
import { allocateFifo, chargeDebtCents, type CreditAbono, type CreditCharge } from "./customerCredit";

describe("parseCustomerListParams", () => {
  it("reads every filter from the URL", () => {
    expect(parseCustomerListParams({ q: "  Empresa  ", type: "company", status: "overdue", sort: "debt", page: "3" })).toEqual({
      q: "Empresa",
      type: "company",
      status: "overdue",
      sort: "debt",
      page: 3,
    });
  });
  it("falls back to the defaults for anything it does not understand", () => {
    // `relevance` es sólo del buscador del cobro: la pantalla no lo acepta por URL.
    expect(parseCustomerListParams({ type: "x", status: "fiado", sort: "relevance", page: "-2" })).toEqual(DEFAULT_CUSTOMER_LIST_PARAMS);
    expect(parseCustomerListParams({ page: "2.5" }).page).toBe(1);
    expect(parseCustomerListParams({ page: "9999999" }).page).toBe(1);
    expect(parseCustomerListParams({ q: ["uno", "dos"] }).q).toBe("uno");
    expect(parseCustomerListParams({ q: "x".repeat(500) }).q).toHaveLength(120);
  });
});

describe("customerListQuery / customerListHref", () => {
  it("omits defaults so the clean URL stays /operator/clientes", () => {
    expect(customerListHref(DEFAULT_CUSTOMER_LIST_PARAMS)).toBe("/operator/clientes");
    expect(customerListQuery({ sort: "relevance" })).toBe("");
  });
  it("round-trips through the parser", () => {
    const params = { q: "ñandú & co", type: "person", status: "debt", sort: "recent", page: 4 } as const;
    const href = customerListHref(params);
    expect(href).toBe("/operator/clientes?q=%C3%B1and%C3%BA+%26+co&type=person&status=debt&sort=recent&page=4");
    const sp = Object.fromEntries(new URL(href, "http://x").searchParams);
    expect(parseCustomerListParams(sp)).toEqual(params);
  });
  it("knows when the list is narrowed", () => {
    expect(hasCustomerFilters(DEFAULT_CUSTOMER_LIST_PARAMS)).toBe(false);
    expect(hasCustomerFilters({ q: "a", type: "all", status: "all" })).toBe(true);
    expect(hasCustomerFilters({ q: "", type: "company", status: "all" })).toBe(true);
    expect(hasCustomerFilters({ q: "", type: "all", status: "discount" })).toBe(true);
  });
});

describe("search normalization", () => {
  it("strips dots, spaces and the NIT check digit for document matching", () => {
    expect(normalizeCustomerSearch(" 901.944.469-1 ")).toEqual({ text: "901.944.469-1", document: "901944469" });
    expect(normalizeCustomerSearch("e 445 566")).toEqual({ text: "e 445 566", document: "E445566" });
  });
  it("escapes LIKE wildcards so they match literally", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
  it("maps the type filter to document types", () => {
    expect(docTypesForFilter("company")).toEqual(["NIT"]);
    expect(docTypesForFilter("person")).toEqual(["CC", "CE", "PA"]);
    expect(docTypesForFilter("all")).toBeNull();
  });
});

describe("pageWindow", () => {
  it("describes the visible range", () => {
    expect(pageWindow(1, 128, 50)).toEqual({ page: 1, pageCount: 3, offset: 0, from: 1, to: 50 });
    expect(pageWindow(3, 128, 50)).toEqual({ page: 3, pageCount: 3, offset: 100, from: 101, to: 128 });
  });
  it("clamps a page past the end to the last one and handles an empty list", () => {
    expect(pageWindow(9, 128, 50)).toMatchObject({ page: 3, offset: 100 });
    expect(pageWindow(4, 0, 50)).toEqual({ page: 1, pageCount: 1, offset: 0, from: 0, to: 0 });
    expect(pageWindow(2, 100, 50)).toMatchObject({ page: 2, from: 51, to: 100 });
  });
  it("bounds the page size the API accepts", () => {
    expect(parsePageSize("20")).toBe(20);
    expect(parsePageSize("5000")).toBe(50);
    expect(parsePageSize(null)).toBe(CUSTOMER_PAGE_SIZE);
    expect(parsePageSize("0")).toBe(CUSTOMER_PAGE_SIZE);
    expect(parsePageSize("abc")).toBe(CUSTOMER_PAGE_SIZE);
  });
});

describe("summaryFromAggregate", () => {
  it("turns Postgres bigints and nulls into numbers", () => {
    expect(
      summaryFromAggregate({ count: 3, creditCount: 1, debtorCount: 1, overdueCount: 0, debtCents: BigInt(18_975_000), overdueCents: null }),
    ).toEqual({
      count: 3,
      creditCount: 1,
      debtorCount: 1,
      overdueCount: 0,
      debtCents: 18_975_000,
      overdueCents: 0,
    });
    expect(summaryFromAggregate(undefined).count).toBe(0);
  });
});

describe("overdue debt", () => {
  const TODAY = "2026-11-04";
  const at = (iso: string) => new Date(`${iso}T15:00:00Z`);
  it("a charge is overdue the day after its due date", () => {
    expect(isChargeOverdue(at("2026-10-05"), 30, TODAY)).toBe(false); // vence hoy
    expect(isChargeOverdue(at("2026-10-04"), 30, TODAY)).toBe(true); // venció ayer
    expect(isChargeOverdue(at("2026-11-04"), 0, TODAY)).toBe(false);
    expect(isChargeOverdue(at("2026-11-03"), 0, TODAY)).toBe(true);
  });

  // Generador determinístico (sin dependencias): mismas corridas siempre.
  function rng(seed: number) {
    let s = seed;
    return () => (s = (s * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  }

  it("the SQL formula max(0, Σ overdue charges − Σ abonos) equals FIFO allocation for any history", () => {
    const rand = rng(7);
    const base = Date.parse(`${TODAY}T12:00:00Z`);
    for (let run = 0; run < 400; run++) {
      const terms = [0, 15, 30, 60][Math.floor(rand() * 4)];
      const charges: CreditCharge[] = Array.from({ length: Math.floor(rand() * 6) }, (_, i) => {
        const amount = Math.floor(rand() * 200_000) * 100;
        return {
          id: `c${i}`,
          date: new Date(base - Math.floor(rand() * 120) * 86_400_000),
          amountCents: amount,
          tipCents: 0,
          refundedCents: rand() < 0.2 ? Math.floor(amount * rand()) : 0,
          creditNoteCents: rand() < 0.1 ? Math.floor(amount * rand() * 0.5) : 0,
        };
      });
      const payments: CreditAbono[] = Array.from({ length: Math.floor(rand() * 4) }, (_, i) => ({
        id: `p${i}`,
        date: new Date(base - Math.floor(rand() * 120) * 86_400_000),
        amountCents: Math.floor(rand() * 150_000) * 100,
      }));
      const fifo = allocateFifo(charges, payments);
      const dates = new Map(charges.map((c) => [c.id, c.date]));
      const viaFifo = fifo.charges
        .filter((c) => isChargeOverdue(dates.get(c.chargeId)!, terms, TODAY))
        .reduce((s, c) => s + c.outstandingCents, 0);
      const overdueCharged = charges
        .filter((c) => isChargeOverdue(c.date, terms, TODAY))
        .reduce((s, c) => s + chargeDebtCents(c), 0);
      const paid = payments.reduce((s, p) => s + p.amountCents, 0);
      expect(overdueFromTotals(overdueCharged, paid)).toBe(viaFifo);
    }
  });
});
