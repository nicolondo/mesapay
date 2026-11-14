import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import {
  expenseListParams,
  hasExpenseFilters,
  isIsoDay,
  isOverdue,
  matchesStatus,
  outstandingOf,
  parseExpenseListParams,
  periodRange,
  searchTerms,
  summarizeExpenses,
  termWhere,
  type ExpenseMoneyRow,
} from "./expenseList";

const sp = (q: string) => new URLSearchParams(q);

describe("parseExpenseListParams", () => {
  it("el mes solo (como siempre) es válido y no trae filtros", () => {
    const f = parseExpenseListParams(sp("month=2026-10"))!;
    expect(f).toEqual({
      period: { kind: "month", month: "2026-10" },
      q: "",
      supplierId: null,
      category: null,
      account: null,
      status: "all",
      page: 1,
    });
    expect(hasExpenseFilters(f)).toBe(false);
  });
  it("rango libre manda sobre el mes; las fechas al revés se ordenan", () => {
    expect(parseExpenseListParams(sp("month=2026-10&desde=2026-11-10&hasta=2026-09-01"))!.period).toEqual({
      kind: "range",
      desde: "2026-09-01",
      hasta: "2026-11-10",
    });
    expect(parseExpenseListParams(sp("fechas=todas"))!.period).toEqual({ kind: "all" });
  });
  it("sin período válido no hay lista (el API responde 400)", () => {
    expect(parseExpenseListParams(sp(""))).toBeNull();
    expect(parseExpenseListParams(sp("month=2026-13"))).toBeNull();
    expect(parseExpenseListParams(sp("desde=2026-02-30&hasta=2026-03-01"))).toBeNull();
  });
  it("limpia los filtros: espacios, estado desconocido, página inválida, cuenta con letras", () => {
    const f = parseExpenseListParams(sp("month=2026-10&q=  arriendo   cerezos &status=raro&page=-3&account=5135ab&supplier=s1&category=Arriendo"))!;
    expect(f).toMatchObject({ q: "arriendo cerezos", status: "all", page: 1, account: "5135", supplierId: "s1", category: "Arriendo" });
    expect(hasExpenseFilters(f)).toBe(true);
  });
  it("ida y vuelta por la URL", () => {
    const q = "desde=2026-10-01&hasta=2026-10-31&q=FE-12&supplier=none&category=Gas&account=5135&status=overdue&page=3";
    const f = parseExpenseListParams(sp(q))!;
    expect(parseExpenseListParams(expenseListParams(f))).toEqual(f);
  });
});

describe("periodRange / isIsoDay", () => {
  it("rango inclusive en días calendario UTC (como el mes)", () => {
    expect(periodRange({ kind: "range", desde: "2026-10-01", hasta: "2026-10-31" })).toEqual({
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-11-01T00:00:00Z"),
    });
    expect(periodRange({ kind: "month", month: "2026-10" })).toEqual({
      from: new Date("2026-10-01T00:00:00Z"),
      to: new Date("2026-11-01T00:00:00Z"),
    });
    expect(periodRange({ kind: "all" })).toBeNull();
  });
  it("valida fechas reales", () => {
    expect(isIsoDay("2026-02-28")).toBe(true);
    expect(isIsoDay("2026-02-29")).toBe(false);
    expect(isIsoDay("1999-01-01")).toBe(false);
  });
});

const row = (o: Partial<ExpenseMoneyRow>): ExpenseMoneyRow => ({
  amountCents: 100_00,
  payableCents: 100_00,
  paidCents: 0,
  dueAt: null,
  ...o,
});

describe("estado de pago", () => {
  const TODAY = "2026-11-13";
  it("saldo = total a pagar − abonado; un gasto viejo sin total a pagar usa su valor", () => {
    expect(outstandingOf(row({ payableCents: 115_00, paidCents: 15_00 }))).toBe(100_00);
    expect(outstandingOf(row({ amountCents: 80_00, payableCents: 0, paidCents: 0 }))).toBe(80_00);
    expect(outstandingOf(row({ payableCents: 50_00, paidCents: 60_00 }))).toBe(0);
  });
  it("vencido: con saldo y un vencimiento pactado que ya pasó (hoy no cuenta)", () => {
    expect(isOverdue(row({ dueAt: new Date("2026-11-12T17:00:00Z") }), TODAY)).toBe(true);
    expect(isOverdue(row({ dueAt: new Date("2026-11-13T17:00:00Z") }), TODAY)).toBe(false);
    expect(isOverdue(row({ dueAt: null }), TODAY)).toBe(false);
    expect(isOverdue(row({ dueAt: new Date("2026-11-01T17:00:00Z"), paidCents: 100_00 }), TODAY)).toBe(false);
    expect(matchesStatus(row({ paidCents: 100_00 }), "paid", TODAY)).toBe(true);
  });
  it("totales del conjunto filtrado y conteo de cada pestaña, en una pasada", () => {
    const rows = [
      row({ amountCents: 100_00, payableCents: 115_00, paidCents: 115_00 }), // pagado (IVA)
      row({ amountCents: 200_00, payableCents: 190_00, paidCents: 90_00, dueAt: new Date("2026-11-01T17:00:00Z") }), // vencido
      row({ amountCents: 50_00, payableCents: 0, paidCents: 0 }), // viejo, por pagar
    ];
    const all = summarizeExpenses(rows, "all", TODAY);
    expect(all.counts).toEqual({ all: 3, pending: 2, overdue: 1, paid: 1 });
    expect(all.summary).toEqual({
      count: 3,
      costCents: 350_00,
      payableCents: 355_00,
      paidCents: 205_00,
      outstandingCents: 150_00,
      overdueCount: 1,
      overdueCents: 100_00,
    });
    const pending = summarizeExpenses(rows, "pending", TODAY);
    expect(pending.counts).toEqual(all.counts);
    expect(pending.summary).toMatchObject({ count: 2, payableCents: 240_00, outstandingCents: 150_00 });
    expect(summarizeExpenses(rows, "paid", TODAY).summary).toMatchObject({ count: 1, outstandingCents: 0 });
  });
});

describe("búsqueda", () => {
  it("palabras sin repetir, como mucho cinco", () => {
    expect(searchTerms("arriendo  cerezos arriendo")).toEqual(["arriendo", "cerezos"]);
    expect(searchTerms("a b c d e f g")).toHaveLength(5);
  });
  it("una palabra busca en documento, concepto, descripción y proveedor", () => {
    const w = termWhere("cerezos", []);
    expect(w.OR).toHaveLength(4);
    expect(w.OR).toContainEqual({ supplier: { is: { name: { contains: "cerezos", mode: "insensitive" } } } });
  });
  it("«G-0012» o «12» buscan también el consecutivo; un NIT con puntos busca por dígitos; un código, por cuenta", () => {
    expect(termWhere("G-0012", []).OR).toContainEqual({ number: 12 });
    const digits = termWhere("5135", []).OR!;
    expect(digits).toContainEqual({ number: 5135 });
    expect(digits).toContainEqual({ accountCode: { startsWith: "5135" } });
    expect(termWhere("900.481.516", []).OR).toContainEqual({ supplier: { is: { taxId: { contains: "900481516" } } } });
  });
  it("las cuentas cuyo nombre contiene la palabra llegan como códigos", () => {
    expect(termWhere("arrendamientos", ["512010"]).OR).toContainEqual({ accountCode: { in: ["512010"] } });
  });
});
