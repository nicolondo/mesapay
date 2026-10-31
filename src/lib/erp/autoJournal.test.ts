// Asientos automáticos: qué meses se regeneran, el lock por comercio y que
// un mes que falla no frena a los demás. El motor (posting.ts) va mockeado;
// el recorrido real contra el motor está en autoJournal.engine.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  /** Advisory locks tomados: llave → transacción dueña. */
  held: new Map<string, symbol>(),
  sql: [] as string[],
  txOpts: [] as unknown[],
  gen: vi.fn(),
  cfg: vi.fn(),
  /** `_min` de cada modelo para firstActivityMonth. */
  mins: {} as Record<string, unknown>,
  numberedRows: [] as Array<{ sourceRef: string }>,
  numberedWhere: [] as unknown[],
}));

vi.mock("@/lib/db", () => {
  const agg = (model: string, field: string) => ({
    aggregate: async () => ({ _min: { [field]: m.mins[model] ?? null } }),
  });
  return {
    db: {
      order: agg("order", "paidAt"),
      purchaseOrder: agg("purchaseOrder", "receivedAt"),
      purchasePayment: agg("purchasePayment", "paidAt"),
      expense: agg("expense", "date"),
      expensePayment: agg("expensePayment", "paidAt"),
      customerCreditPayment: agg("customerCreditPayment", "paidAt"),
      stockMovement: agg("stockMovement", "createdAt"),
      payrollRun: agg("payrollRun", "month"),
      fixedAsset: agg("fixedAsset", "purchaseDate"),
      deferredItem: agg("deferredItem", "startDate"),
      journalEntry: {
        findMany: async (args: unknown) => {
          m.numberedWhere.push(args);
          return m.numberedRows;
        },
      },
      // Transacción falsa con advisory locks de verdad (en memoria): el lock
      // es de la transacción y se suelta al terminar, como en Postgres.
      $transaction: async (fn: (tx: unknown) => Promise<unknown>, opts: unknown) => {
        m.txOpts.push(opts);
        const id = Symbol("tx");
        const tx = {
          $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join("$");
            m.sql.push(sql);
            const key = `${String(values[0])}:${/hashtext\(\$\), (\d+)\)/.exec(sql)?.[1]}`;
            const owner = m.held.get(key);
            if (owner && owner !== id) return [{ locked: false }];
            m.held.set(key, id);
            return [{ locked: true }];
          },
        };
        try {
          return await fn(tx);
        } finally {
          for (const [k, v] of m.held) if (v === id) m.held.delete(k);
        }
      },
    },
  };
});
vi.mock("./posting", () => ({ generateJournalForMonth: m.gen }));
vi.mock("./cierre", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cierre")>()),
  getAccountingConfig: m.cfg,
}));

import {
  ENGINE_SOURCES,
  JOURNAL_LOCK_CLASS,
  firstActivityMonth,
  openMonthsToRegenerate,
  regenerateOpenMonths,
  withJournalLock,
} from "./autoJournal";

const NOW = new Date("2026-11-15T10:30:00Z");

function config(closedThrough: string | null = null) {
  m.cfg.mockResolvedValue({ uvtCents: 5_237_400, closedThrough, nextVoucherNumber: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.held.clear();
  m.sql.length = 0;
  m.txOpts.length = 0;
  m.numberedRows = [];
  m.numberedWhere.length = 0;
  m.mins = {};
  config();
  m.gen.mockImplementation(async (_r: string, month: string) => [{ source: "sale", totalCents: month.length }]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openMonthsToRegenerate", () => {
  it("comercio nuevo (sin actividad): ningún mes", () => {
    expect(
      openMonthsToRegenerate({ firstActivityMonth: null, closedThrough: null, currentMonth: "2026-11" }),
    ).toEqual([]);
  });

  it("sin cierre: del primer mes con actividad al mes en curso, todos seguidos", () => {
    expect(
      openMonthsToRegenerate({ firstActivityMonth: "2026-09", closedThrough: null, currentMonth: "2026-11" }),
    ).toEqual(["2026-09", "2026-10", "2026-11"]);
  });

  it("cierre en el medio del período con actividad: sólo los meses posteriores al cerrado", () => {
    expect(
      openMonthsToRegenerate({ firstActivityMonth: "2026-07", closedThrough: "2026-09", currentMonth: "2026-11" }),
    ).toEqual(["2026-10", "2026-11"]);
  });

  it("todo cerrado hasta el mes en curso (o más allá): ningún mes", () => {
    expect(
      openMonthsToRegenerate({ firstActivityMonth: "2026-07", closedThrough: "2026-11", currentMonth: "2026-11" }),
    ).toEqual([]);
    expect(
      openMonthsToRegenerate({ firstActivityMonth: "2026-07", closedThrough: "2026-12", currentMonth: "2026-11" }),
    ).toEqual([]);
  });

  it("un cierre anterior a la actividad no adelanta el comienzo", () => {
    expect(
      openMonthsToRegenerate({ firstActivityMonth: "2026-10", closedThrough: "2026-03", currentMonth: "2026-11" }),
    ).toEqual(["2026-10", "2026-11"]);
  });

  it("cruza el cambio de año", () => {
    expect(
      openMonthsToRegenerate({ firstActivityMonth: "2025-11", closedThrough: null, currentMonth: "2026-02" }),
    ).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("actividad sólo a futuro: nada hasta que llegue ese mes", () => {
    expect(
      openMonthsToRegenerate({ firstActivityMonth: "2026-12", closedThrough: null, currentMonth: "2026-11" }),
    ).toEqual([]);
  });

  it("una fecha anterior a 2020 (inválida para el motor) arranca en 2020-01", () => {
    const months = openMonthsToRegenerate({
      firstActivityMonth: "2019-06",
      closedThrough: null,
      currentMonth: "2020-02",
    });
    expect(months).toEqual(["2020-01", "2020-02"]);
  });
});

describe("firstActivityMonth", () => {
  it("sin nada en ninguna fuente: null", async () => {
    expect(await firstActivityMonth("r1")).toBeNull();
  });

  it("toma el mes más antiguo entre todas las fuentes", async () => {
    m.mins = {
      order: new Date("2026-09-03T15:00:00Z"),
      expense: new Date("2026-08-20T12:00:00Z"),
      purchaseOrder: new Date("2026-10-01T00:00:00Z"),
    };
    expect(await firstActivityMonth("r1")).toBe("2026-08");
  });

  it("nómina (mes en texto) y activos (desde el mes siguiente a la compra) también cuentan", async () => {
    m.mins = { payrollRun: "2026-06", order: new Date("2026-09-03T15:00:00Z") };
    expect(await firstActivityMonth("r1")).toBe("2026-06");
    m.mins = { fixedAsset: new Date("2026-04-10T12:00:00Z"), order: new Date("2026-09-03T15:00:00Z") };
    expect(await firstActivityMonth("r1")).toBe("2026-05");
  });
});

describe("regenerateOpenMonths", () => {
  it("comercio sin actividad: no llama al motor", async () => {
    const run = await regenerateOpenMonths("r1", NOW);
    expect(run).toMatchObject({ status: "done", months: [] });
    expect(m.gen).not.toHaveBeenCalled();
  });

  it("corre el motor por cada mes abierto con el MISMO rango que la ruta (monthRange, UTC)", async () => {
    m.mins = { order: new Date("2026-09-03T15:00:00Z") };
    const run = await regenerateOpenMonths("r1", NOW);
    expect(run.status).toBe("done");
    expect(m.gen.mock.calls.map((c) => c[1])).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(m.gen).toHaveBeenCalledWith("r1", "2026-10", {
      from: new Date(Date.UTC(2026, 9, 1)),
      to: new Date(Date.UTC(2026, 10, 1)),
    });
  });

  it("respeta el cierre: los meses <= closedThrough no se regeneran", async () => {
    config("2026-09");
    m.mins = { order: new Date("2026-08-03T15:00:00Z") };
    const run = await regenerateOpenMonths("r1", NOW);
    expect(m.gen.mock.calls.map((c) => c[1])).toEqual(["2026-10", "2026-11"]);
    expect(run).toMatchObject({ status: "done", closedThrough: "2026-09", firstActivityMonth: "2026-08" });
  });

  it("un mes reabierto con comprobantes del motor numerados o anulados no se regenera solo", async () => {
    m.mins = { order: new Date("2026-09-03T15:00:00Z") };
    m.numberedRows = [{ sourceRef: "2026-10" }];
    const run = await regenerateOpenMonths("r1", NOW);
    expect(m.gen.mock.calls.map((c) => c[1])).toEqual(["2026-09", "2026-11"]);
    expect(run.status === "done" && run.months.map((x) => x.status)).toEqual(["ok", "numbered", "ok"]);
    // La consulta mira sólo asientos del motor (nunca los manuales).
    const where = (m.numberedWhere[0] as { where: { source: { in: string[] } } }).where;
    expect(where.source.in).toEqual([...ENGINE_SOURCES]);
    expect(where.source.in).not.toContain("manual");
  });

  it("si un mes falla, lo loguea y sigue con el siguiente", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    m.mins = { order: new Date("2026-09-03T15:00:00Z") };
    m.gen.mockImplementation(async (_r: string, month: string) => {
      if (month === "2026-10") throw new Error("boom");
      return [{ source: "sale", totalCents: 1 }];
    });
    const run = await regenerateOpenMonths("r1", NOW);
    expect(m.gen).toHaveBeenCalledTimes(3);
    expect(run.status === "done" && run.months).toEqual([
      { month: "2026-09", status: "ok", results: [{ source: "sale", totalCents: 1 }] },
      { month: "2026-10", status: "error", error: "boom" },
      { month: "2026-11", status: "ok", results: [{ source: "sale", totalCents: 1 }] },
    ]);
    expect(log).toHaveBeenCalledWith(
      "[autoJournal] el mes falló",
      expect.objectContaining({ restaurantId: "r1", month: "2026-10", error: "boom" }),
    );
  });
});

describe("lock por comercio", () => {
  /** Motor que se queda "trabajando" hasta que el test lo suelta. */
  function slowEngine() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let active = 0;
    let maxActive = 0;
    m.gen.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      return [];
    });
    return { release, maxActive: () => maxActive };
  }

  it("dos corridas en paralelo del mismo comercio no se pisan: la segunda sale busy", async () => {
    m.mins = { order: new Date("2026-10-03T15:00:00Z") };
    const engine = slowEngine();
    const first = regenerateOpenMonths("r1", NOW);
    await vi.waitFor(() => expect(m.gen).toHaveBeenCalled());
    const second = await regenerateOpenMonths("r1", NOW);
    expect(second).toEqual({ restaurantId: "r1", status: "busy", months: [] });
    engine.release();
    expect((await first).status).toBe("done");
    // Sólo la primera corrida llamó al motor (2026-10 y 2026-11).
    expect(m.gen).toHaveBeenCalledTimes(2);
    expect(engine.maxActive()).toBe(1);
  });

  it("con espera, la segunda corrida entra cuando la primera suelta el lock (nunca a la vez)", async () => {
    m.mins = { order: new Date("2026-11-03T15:00:00Z") };
    const engine = slowEngine();
    const first = regenerateOpenMonths("r1", NOW);
    await vi.waitFor(() => expect(m.gen).toHaveBeenCalledTimes(1));
    const second = regenerateOpenMonths("r1", NOW, { waitMs: 5_000 });
    // Mientras la primera trabaja, la segunda no llega al motor.
    await new Promise((r) => setTimeout(r, 300));
    expect(m.gen).toHaveBeenCalledTimes(1);
    engine.release();
    expect((await first).status).toBe("done");
    expect((await second).status).toBe("done");
    expect(m.gen).toHaveBeenCalledTimes(2);
    expect(engine.maxActive()).toBe(1);
  });

  it("el lock es POR comercio: otro comercio corre en paralelo", async () => {
    m.mins = { order: new Date("2026-11-03T15:00:00Z") };
    const engine = slowEngine();
    const a = regenerateOpenMonths("r1", NOW);
    const b = regenerateOpenMonths("r2", NOW);
    await vi.waitFor(() => expect(m.gen).toHaveBeenCalledTimes(2));
    expect(engine.maxActive()).toBe(2);
    engine.release();
    expect((await a).status).toBe("done");
    expect((await b).status).toBe("done");
  });

  it("el botón (withJournalLock) y la corrida diaria comparten la misma llave", async () => {
    m.mins = { order: new Date("2026-11-03T15:00:00Z") };
    const engine = slowEngine();
    const daily = regenerateOpenMonths("r1", NOW);
    await vi.waitFor(() => expect(m.gen).toHaveBeenCalled());
    const button = await withJournalLock("r1", async () => "regenerado");
    expect(button).toEqual({ ok: false, reason: "busy" });
    engine.release();
    await daily;
    expect(await withJournalLock("r1", async () => "regenerado")).toEqual({ ok: true, value: "regenerado" });
  });

  it("un error dentro del lock lo suelta igual", async () => {
    await expect(
      withJournalLock("r1", async () => {
        throw new Error("falla");
      }),
    ).rejects.toThrow("falla");
    expect(m.held.size).toBe(0);
    expect(await withJournalLock("r1", async () => 1)).toEqual({ ok: true, value: 1 });
  });

  it("usa pg_try_advisory_xact_lock con la clase 949 como literal y un tope de transacción", async () => {
    await withJournalLock("r1", async () => null, { waitMs: 1_000, holdMs: 60_000 });
    expect(m.sql[0]).toContain("pg_try_advisory_xact_lock(hashtext($), 949)");
    expect(JOURNAL_LOCK_CLASS).toBe(949);
    expect(m.txOpts[0]).toEqual(expect.objectContaining({ timeout: 61_000 }));
  });
});

describe("ENGINE_SOURCES", () => {
  it("coincide con las fuentes que arma el motor en posting.ts", () => {
    const code = readFileSync(path.join(__dirname, "posting.ts"), "utf8");
    const sources = new Set([...code.matchAll(/source: "([a-z_]+)",\s*memo:/g)].map((x) => x[1]));
    expect([...sources].sort()).toEqual([...ENGINE_SOURCES].sort());
  });
});
