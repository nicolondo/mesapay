// Cron de asientos automáticos: el secreto es la única puerta; sólo entran
// los comercios con el módulo de contabilidad (no suspendidos) y uno que
// falla no frena a los demás.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ findMany: vi.fn(), regen: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/db", () => ({ db: { restaurant: { findMany: m.findMany } } }));
vi.mock("@/lib/erp/autoJournal", () => ({
  DAILY_LOCK_WAIT_MS: 15_000,
  regenerateOpenMonths: m.regen,
}));

import { POST } from "./route";
import { runDailyAccounting } from "@/lib/erp/autoJournalDaily";

const req = (secret?: string) =>
  new Request("http://localhost/api/cron/accounting-daily", {
    method: "POST",
    headers: secret ? { "x-cron-secret": secret } : {},
  });

const original = process.env.CRON_SECRET;

const done = (restaurantId: string, months: string[]) => ({
  restaurantId,
  status: "done",
  firstActivityMonth: months[0] ?? null,
  closedThrough: null,
  months: months.map((month) => ({ month, status: "ok", results: [{ source: "sale", totalCents: 1 }] })),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  process.env.CRON_SECRET = "s3cr3t";
  m.findMany.mockResolvedValue([
    { id: "conta-1", enabledModules: ["accounting", "inventory"] },
    { id: "sin-modulo", enabledModules: ["inventory"] },
    { id: "conta-2", enabledModules: ["accounting"] },
    { id: "modulos-null", enabledModules: null },
  ]);
  m.regen.mockImplementation(async (id: string) => done(id, ["2026-10", "2026-11"]));
});

afterEach(() => {
  process.env.CRON_SECRET = original;
  vi.restoreAllMocks();
});

describe("POST /api/cron/accounting-daily", () => {
  it("401 sin secreto o con el secreto equivocado", async () => {
    expect((await POST(req())).status).toBe(401);
    expect((await POST(req("otro"))).status).toBe(401);
    expect(m.findMany).not.toHaveBeenCalled();
    expect(m.regen).not.toHaveBeenCalled();
  });

  it("401 si el servidor no tiene CRON_SECRET configurado (nunca abierto por defecto)", async () => {
    process.env.CRON_SECRET = "";
    expect((await POST(req(""))).status).toBe(401);
    expect(m.regen).not.toHaveBeenCalled();
  });

  it("sólo comercios con el módulo de contabilidad y no suspendidos, uno por uno", async () => {
    const res = await POST(req("s3cr3t"));
    expect(res.status).toBe(200);
    expect(m.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { suspended: false } }));
    expect(m.regen.mock.calls.map((c) => c[0])).toEqual(["conta-1", "conta-2"]);
    // Con la espera del lock de la corrida diaria (cubre un botón en curso).
    expect(m.regen).toHaveBeenCalledWith("conta-1", expect.any(Date), { waitMs: 15_000 });
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      restaurants: 2,
      done: 2,
      failed: 0,
      busy: 0,
      pending: 0,
      truncated: false,
      months: { ok: 4, error: 0, numbered: 0, closed: 0, invalid: 0 },
    });
    expect(body.runs[0]).toEqual({
      restaurantId: "conta-1",
      status: "done",
      months: [
        { month: "2026-10", status: "ok", entries: 1 },
        { month: "2026-11", status: "ok", entries: 1 },
      ],
    });
  });

  it("un comercio con error no frena a los demás", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    m.findMany.mockResolvedValue([
      { id: "a", enabledModules: ["accounting"] },
      { id: "b", enabledModules: ["accounting"] },
      { id: "c", enabledModules: ["accounting"] },
    ]);
    m.regen.mockImplementation(async (id: string) => {
      if (id === "b") throw new Error("db caída");
      return done(id, ["2026-11"]);
    });
    const res = await POST(req("s3cr3t"));
    const body = await res.json();
    expect(m.regen.mock.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
    expect(body).toMatchObject({ ok: true, restaurants: 3, done: 2, failed: 1 });
    expect(body.runs[1]).toEqual({ restaurantId: "b", status: "failed", months: [], error: "db caída" });
    expect(log).toHaveBeenCalledWith(
      "[cron accounting-daily] el comercio falló",
      expect.objectContaining({ restaurantId: "b" }),
    );
  });

  it("cuenta los meses con error, los numerados y los comercios ocupados (lock tomado)", async () => {
    m.findMany.mockResolvedValue([
      { id: "a", enabledModules: ["accounting"] },
      { id: "b", enabledModules: ["accounting"] },
    ]);
    m.regen.mockImplementation(async (id: string) =>
      id === "a"
        ? { restaurantId: "a", status: "busy", months: [] }
        : {
            ...done("b", []),
            months: [
              { month: "2026-09", status: "numbered" },
              { month: "2026-10", status: "error", error: "x" },
              { month: "2026-11", status: "ok", results: [] },
            ],
          },
    );
    const body = await (await POST(req("s3cr3t"))).json();
    expect(body).toMatchObject({
      busy: 1,
      done: 1,
      months: { ok: 1, error: 1, numbered: 1 },
    });
  });
});

describe("runDailyAccounting", () => {
  it("con el tope de tiempo agotado no empieza más comercios y los deja como pending", async () => {
    const summary = await runDailyAccounting({ budgetMs: 0 });
    expect(m.regen).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ restaurants: 2, pending: 2, truncated: true, done: 0 });
  });

  it("loguea un resumen sin el detalle por comercio", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runDailyAccounting();
    const [tag, json] = log.mock.calls.at(-1)!;
    expect(tag).toBe("[cron accounting-daily]");
    const parsed = JSON.parse(String(json));
    expect(parsed).toMatchObject({ restaurants: 2, done: 2 });
    expect(parsed.runs).toBeUndefined();
  });
});
