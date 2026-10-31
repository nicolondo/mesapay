// Reportes contables con montos por encima de INT4, leídos como los entrega
// Prisma desde columnas BIGINT: `bigint` en las lecturas de modelo y en el
// SQL crudo (los SUM van casteados `::bigint`). Recorre la capa de consultas
// real y las funciones puras de cada reporte, y verifica que los totales
// cuadren al centavo y que el resultado se serialice a JSON sin `bigint`.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

/** Ventas de Son y Melona: septiembre y octubre de 2026 (centavos). */
const h = vi.hoisted(() => {
  const SEP = 9_208_811_100;
  const OCT = 24_179_580_000;
  const big = (n: number) => BigInt(n);
  const SEP_ENTRY = { id: "e-sep", date: new Date("2026-09-30T23:59:59.999Z"), voucherNumber: 1, source: "sale", memo: "Ventas 2026-09", status: "posted", createdAt: new Date("2026-10-01T05:00:00Z") };
  const OCT_ENTRY = { id: "e-oct", date: new Date("2026-10-31T23:59:59.999Z"), voucherNumber: null, source: "sale", memo: "Ventas 2026-10", status: "posted", createdAt: new Date("2026-10-31T05:00:00Z") };

  /** Filas crudas que devolvería Postgres para cada consulta. */
  function rawRows(text: string): unknown[] {
    if (text.includes('AS "initialCents"')) {
      return [
        { accountCode: "110505", initialCents: big(SEP), debitCents: big(OCT), creditCents: big(0), finalCents: big(SEP + OCT) },
        { accountCode: "413505", initialCents: big(-SEP), debitCents: big(0), creditCents: big(OCT), finalCents: big(-(SEP + OCT)) },
      ];
    }
    if (text.includes('AS "balanceCents"')) {
      return [
        { accountCode: "110505", balanceCents: big(SEP + OCT) },
        { accountCode: "413505", balanceCents: big(-(SEP + OCT)) },
      ];
    }
    if (text.includes('AS "movementCents"')) {
      return [
        { accountCode: "413505", month: "2026-09", movementCents: big(-SEP) },
        { accountCode: "413505", month: "2026-10", movementCents: big(-OCT) },
      ];
    }
    if (text.includes('l."debitCents", l."creditCents"')) {
      return [
        { ...OCT_ENTRY, id: "t1", entryId: "e-oct", accountCode: "240805", debitCents: big(0), creditCents: big(OCT), thirdPartyName: null, thirdPartyTaxId: null },
      ];
    }
    throw new Error(`consulta cruda inesperada: ${text}`);
  }
  return { SEP, OCT, big, SEP_ENTRY, OCT_ENTRY, rawRows, sql: [] as string[] };
});
const { SEP, OCT } = h;

vi.mock("@/lib/db", () => {
  const { big, SEP, OCT, SEP_ENTRY, OCT_ENTRY } = h;
  const lines = [
    { id: "l1", entryId: "e-sep", accountCode: "110505", debitCents: big(SEP), creditCents: big(0), memo: null, entry: SEP_ENTRY },
    { id: "l2", entryId: "e-sep", accountCode: "413505", debitCents: big(0), creditCents: big(SEP), memo: null, entry: SEP_ENTRY },
    { id: "l3", entryId: "e-oct", accountCode: "110505", debitCents: big(OCT), creditCents: big(0), memo: null, entry: OCT_ENTRY },
    { id: "l4", entryId: "e-oct", accountCode: "413505", debitCents: big(0), creditCents: big(OCT), memo: null, entry: OCT_ENTRY },
  ];
  const names: Record<string, string> = { "110505": "Caja general", "413505": "Ventas" };
  return {
    db: {
      $queryRaw: async (sql: Prisma.Sql) => {
        h.sql.push(sql.text);
        return h.rawRows(sql.text);
      },
      journalLine: { findMany: async () => lines },
      journalEntry: {
        findMany: async ({ where }: { where: { date: { gte: Date } } }) =>
          [SEP_ENTRY, OCT_ENTRY]
            .filter((e) => e.date >= where.date.gte)
            .map((e) => ({
              ...e,
              lines: lines
                .filter((l) => l.entryId === e.id)
                .map((l) => ({ accountCode: l.accountCode, debitCents: l.debitCents, creditCents: l.creditCents, memo: l.memo, account: { name: names[l.accountCode]! } })),
            })),
      },
    },
  };
});

import {
  loadBalancesThrough,
  loadEntriesWithLines,
  loadLedgerLines,
  loadResultMovements,
  loadTrialBalanceRows,
} from "./queries";
import { loadTaxLedgerLines } from "./taxesQueries";
import { buildTrialBalance } from "./trialBalance";
import { buildBalanceSheet } from "./balanceSheet";
import { buildIncomeStatement, type ResultAccountInput } from "./incomeStatement";
import { buildGeneralLedger } from "./generalLedger";
import { buildDailyBook } from "./dailyBook";

const ACCOUNTS: (ResultAccountInput & { nature: string })[] = [
  { code: "1", name: "Activo", type: "activo", nature: "debito" },
  { code: "11", name: "Disponible", type: "activo", nature: "debito" },
  { code: "1105", name: "Caja", type: "activo", nature: "debito" },
  { code: "110505", name: "Caja general", type: "activo", nature: "debito" },
  { code: "4", name: "Ingresos", type: "ingreso", nature: "credito" },
  { code: "41", name: "Operacionales", type: "ingreso", nature: "credito" },
  { code: "4135", name: "Comercio", type: "ingreso", nature: "credito" },
  { code: "413505", name: "Ventas", type: "ingreso", nature: "credito" },
];

const OCT_FROM = new Date("2026-10-01T00:00:00Z");
const NOV_FROM = new Date("2026-11-01T00:00:00Z");

/** Ningún `bigint` en todo el árbol y el JSON vuelve idéntico. */
function expectJsonSafe(value: unknown) {
  const walk = (v: unknown, path: string) => {
    expect(typeof v, path).not.toBe("bigint");
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  walk(value, "$");
  expect(() => JSON.stringify(value)).not.toThrow();
}

beforeEach(() => {
  h.sql = [];
});

describe("SQL crudo sobre BIGINT", () => {
  it("cada SUM vuelve casteado a bigint (no NUMERIC/Decimal)", async () => {
    await loadTrialBalanceRows("r1", OCT_FROM, NOV_FROM);
    await loadBalancesThrough("r1", NOV_FROM);
    await loadResultMovements("r1", new Date("2026-09-01T00:00:00Z"), NOV_FROM);
    expect(h.sql).toHaveLength(3);
    for (const text of h.sql) {
      const sums = text.match(/SUM\(/g)?.length ?? 0;
      expect(sums).toBeGreaterThan(0);
      expect(text.match(/, 0\)::bigint AS "/g)?.length).toBe(sums);
    }
  });
});

describe("reportes con montos > INT4 leídos como bigint", () => {
  it("balance de prueba: octubre suma $241 M exactos y cuadra", async () => {
    const rows = await loadTrialBalanceRows("r1", OCT_FROM, NOV_FROM);
    expectJsonSafe(rows);
    const tb = buildTrialBalance(rows, { level: 6, accounts: ACCOUNTS });
    expect(tb.totals).toEqual({ initialCents: 0, debitCents: OCT, creditCents: OCT, finalCents: 0 });
    expect(tb.rows.find((r) => r.code === "110505")).toMatchObject({ initialCents: SEP, debitCents: OCT, finalCents: SEP + OCT });
    expectJsonSafe(tb);
  });

  it("estado de situación financiera: el activo y la utilidad del año acumulan $334 M", async () => {
    const balances = await loadBalancesThrough("r1", NOV_FROM);
    const bs = buildBalanceSheet({ balances, accounts: ACCOUNTS, cutoff: "2026-10-31", openYearStart: "2026-01-01", utilidadLabel: "Utilidad" });
    expect(bs.totals.activoCents).toBe(SEP + OCT);
    expect(bs.totals.utilidadCents).toBe(SEP + OCT);
    expect(bs.totals.differenceCents).toBe(0);
    expect(bs.balanced).toBe(true);
    expectJsonSafe(bs);
  });

  it("estado de resultados: los ingresos de septiembre y octubre suman exacto", async () => {
    const movements = await loadResultMovements("r1", new Date("2026-09-01T00:00:00Z"), NOV_FROM);
    const is = buildIncomeStatement({ movements, accounts: ACCOUNTS, country: "CO", from: "2026-09-01", to: "2026-10-31" });
    expect(is.summary.incomeCents).toBe(SEP + OCT);
    expect(is.months.map((x) => [x.key, x.incomeCents])).toEqual([
      ["2026-09", SEP],
      ["2026-10", OCT],
    ]);
    expectJsonSafe(is);
  });

  it("libro mayor: saldo inicial de septiembre + movimiento de octubre", async () => {
    const lines = await loadLedgerLines("r1", NOV_FROM);
    expectJsonSafe(lines);
    const ledger = buildGeneralLedger(lines, ACCOUNTS, { from: OCT_FROM, to: NOV_FROM });
    expect(ledger.totals).toEqual({ debitCents: OCT, creditCents: OCT });
    expect(ledger.balanced).toBe(true);
    expect(ledger.accounts.find((a) => a.code === "110505")).toMatchObject({ initialCents: SEP, debitCents: OCT, balanceCents: SEP + OCT });
    expectJsonSafe(ledger);
  });

  it("libro diario: el comprobante de octubre trae sus líneas exactas", async () => {
    const entries = await loadEntriesWithLines("r1", OCT_FROM, NOV_FROM);
    const book = buildDailyBook(entries, { mode: "detallado" });
    expect(book.stats).toMatchObject({ entries: 1, debitCents: OCT, creditCents: OCT, balanced: true });
    expectJsonSafe(book);
  });

  it("auxiliar de impuestos: las líneas crudas llegan en number", async () => {
    const lines = await loadTaxLedgerLines("r1", OCT_FROM, NOV_FROM, ["2408"]);
    expect(lines).toEqual([expect.objectContaining({ accountCode: "240805", debitCents: 0, creditCents: OCT })]);
    expectJsonSafe(lines);
  });
});
