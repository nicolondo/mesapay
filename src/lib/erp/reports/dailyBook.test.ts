import { describe, expect, it } from "vitest";
import { buildDailyBook, dailyBookCsvRows, parseDailyBookMode, type DailyBookEntryInput } from "./dailyBook";

const entries: DailyBookEntryInput[] = [
  {
    id: "e-sale",
    date: "2026-08-31T23:59:59.999Z",
    voucherNumber: 2,
    source: "sale",
    memo: "Ventas de agosto",
    status: "posted",
    createdAt: "2026-09-01T00:00:00Z",
    lines: [
      { accountCode: "413505", accountName: "Ventas", debitCents: 0, creditCents: 100_000 },
      { accountCode: "110505", accountName: "Caja", debitCents: 100_000, creditCents: 0 },
    ],
  },
  {
    id: "e-cogs",
    date: "2026-08-31T23:59:59.999Z",
    voucherNumber: 1,
    source: "cogs",
    memo: null,
    status: "posted",
    createdAt: "2026-09-01T00:00:01Z",
    lines: [
      { accountCode: "613505", accountName: "Costo", debitCents: 40_000, creditCents: 0 },
      { accountCode: "143505", accountName: "Inventario", debitCents: 0, creditCents: 40_000 },
    ],
  },
  {
    id: "e-bank",
    date: "2026-08-10T00:00:00Z",
    voucherNumber: null,
    source: "bank",
    memo: "Comisión bancaria",
    status: "annulled",
    createdAt: "2026-08-10T12:00:00Z",
    lines: [
      { accountCode: "530505", accountName: "Gastos bancarios", debitCents: 1_000, creditCents: 0 },
      { accountCode: "111005", accountName: "Bancos", debitCents: 0, creditCents: 1_000 },
    ],
  },
  {
    id: "e-manual",
    date: "2026-08-10T00:00:00Z",
    voucherNumber: null,
    source: "manual",
    memo: "Ajuste caja",
    status: "posted",
    createdAt: "2026-08-10T09:00:00Z",
    lines: [
      { accountCode: "110505", accountName: "Caja", debitCents: 500, creditCents: 0 },
      { accountCode: "111005", accountName: "Bancos", debitCents: 0, creditCents: 500 },
    ],
  },
];

describe("buildDailyBook — detallado", () => {
  it("ordena por fecha, número (sin numerar al final) y creación; líneas débito primero", () => {
    const book = buildDailyBook(entries, { mode: "detallado" });
    if (book.mode !== "detallado") throw new Error("mode");
    expect(book.entries.map((e) => e.id)).toEqual(["e-manual", "e-bank", "e-cogs", "e-sale"]);
    const sale = book.entries.find((e) => e.id === "e-sale")!;
    expect(sale.lines.map((l) => l.accountCode)).toEqual(["110505", "413505"]);
    expect(sale).toMatchObject({ debitCents: 100_000, creditCents: 100_000, voided: false });
  });

  it("incluye los anulados marcados", () => {
    const book = buildDailyBook(entries, { mode: "detallado" });
    if (book.mode !== "detallado") throw new Error("mode");
    expect(book.entries.find((e) => e.id === "e-bank")!.voided).toBe(true);
    expect(book.stats.voided).toBe(1);
  });

  it("stats: comprobantes, totales y partida doble", () => {
    const book = buildDailyBook(entries, { mode: "detallado" });
    expect(book.stats).toEqual({
      entries: 4,
      voided: 1,
      debitCents: 141_500,
      creditCents: 141_500,
      balanced: true,
    });
    const broken = buildDailyBook(
      [{ ...entries[0], lines: [{ accountCode: "1", accountName: "x", debitCents: 10, creditCents: 0 }] }],
      { mode: "detallado" },
    );
    expect(broken.stats.balanced).toBe(false);
  });
});

describe("buildDailyBook — anulación por reversa", () => {
  const original: DailyBookEntryInput = {
    id: "e-orig",
    date: "2026-08-05T00:00:00Z",
    voucherNumber: 7,
    source: "manual",
    memo: "Ajuste",
    status: "annulled",
    createdAt: "2026-08-05T10:00:00Z",
    lines: [
      { accountCode: "530505", accountName: "Gastos", debitCents: 9_000, creditCents: 0 },
      { accountCode: "110505", accountName: "Caja", debitCents: 0, creditCents: 9_000 },
    ],
  };
  const reversal: DailyBookEntryInput = {
    id: "e-rev",
    date: "2026-08-06T00:00:00Z",
    voucherNumber: 8,
    source: "manual",
    memo: "Reversa de #000007",
    status: "posted",
    createdAt: "2026-08-06T10:00:00Z",
    lines: [
      { accountCode: "110505", accountName: "Caja", debitCents: 9_000, creditCents: 0 },
      { accountCode: "530505", accountName: "Gastos", debitCents: 0, creditCents: 9_000 },
    ],
  };

  it("el original anulado y su reversa entran los dos, marcados y sumando", () => {
    const book = buildDailyBook([original, reversal], { mode: "detallado" });
    if (book.mode !== "detallado") throw new Error("mode");
    expect(book.entries.map((e) => [e.id, e.voided])).toEqual([
      ["e-orig", true],
      ["e-rev", false],
    ]);
    expect(book.stats).toEqual({ entries: 2, voided: 1, debitCents: 18_000, creditCents: 18_000, balanced: true });
  });

  it("en resumido, día × cuenta netea a cero entre los dos días", () => {
    const book = buildDailyBook([original, reversal], { mode: "resumido" });
    if (book.mode !== "resumido") throw new Error("mode");
    const caja = book.days.flatMap((d) => d.rows).filter((r) => r.accountCode === "110505");
    expect(caja.reduce((s, r) => s + r.debitCents - r.creditCents, 0)).toBe(0);
  });
});

describe("buildDailyBook — resumido", () => {
  it("agrupa por día × cuenta (D. 2649/93 art. 125) sumando débitos y créditos", () => {
    const book = buildDailyBook(entries, { mode: "resumido" });
    if (book.mode !== "resumido") throw new Error("mode");
    expect(book.days.map((d) => d.date)).toEqual(["2026-08-10", "2026-08-31"]);
    const d10 = book.days[0];
    expect(d10.rows).toEqual([
      { accountCode: "110505", accountName: "Caja", debitCents: 500, creditCents: 0 },
      { accountCode: "111005", accountName: "Bancos", debitCents: 0, creditCents: 1_500 },
      { accountCode: "530505", accountName: "Gastos bancarios", debitCents: 1_000, creditCents: 0 },
    ]);
    expect(d10).toMatchObject({ debitCents: 1_500, creditCents: 1_500 });
    const d31 = book.days[1];
    expect(d31.rows.map((r) => r.accountCode)).toEqual(["110505", "143505", "413505", "613505"]);
    expect(d31.debitCents).toBe(140_000);
    // Los stats son los mismos en ambos modos.
    expect(book.stats).toEqual(buildDailyBook(entries, { mode: "detallado" }).stats);
  });

  it("parseDailyBookMode: resumido o detallado (default)", () => {
    expect(parseDailyBookMode("resumido")).toBe("resumido");
    expect(parseDailyBookMode("x")).toBe("detallado");
    expect(parseDailyBookMode(null)).toBe("detallado");
  });
});

describe("dailyBookCsvRows", () => {
  const labels = { unnumbered: "s/n", voided: "ANULADO", sourceLabel: (s: string) => `src:${s}` };

  it("detallado: una fila por línea con comprobante, origen y marca de anulado", () => {
    const rows = dailyBookCsvRows(buildDailyBook(entries, { mode: "detallado" }), labels);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual(["2026-08-10", "s/n", "src:manual", "Ajuste caja", "110505", "Caja", 500, 0]);
    expect(rows[2][3]).toBe("ANULADO · Comisión bancaria");
    expect(rows.at(-1)).toEqual(["2026-08-31", "#000002", "src:sale", "Ventas de agosto", "413505", "Ventas", 0, 100_000]);
  });

  it("resumido: Fecha, Cuenta, Nombre, Débitos, Créditos", () => {
    const rows = dailyBookCsvRows(buildDailyBook(entries, { mode: "resumido" }), labels);
    expect(rows).toHaveLength(7);
    expect(rows[1]).toEqual(["2026-08-10", "111005", "Bancos", 0, 1_500]);
  });
});
