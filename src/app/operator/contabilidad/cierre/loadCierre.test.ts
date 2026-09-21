// Gate y armado de datos de /operator/contabilidad/cierre: sin restaurante
// activo avisa; con el módulo `accounting` apagado la página no existe; con
// él encendido junta config, conteos por mes y cierre anual en un YearStatus.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  activeId: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  queryRaw: vi.fn(),
  notFound: vi.fn(),
  config: vi.fn(),
  closing: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    m.notFound();
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.findUnique },
    journalEntry: { findFirst: m.findFirst },
    $queryRaw: m.queryRaw,
  },
}));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: m.activeId }));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: async () => "COP" }));
vi.mock("@/lib/erp/cierre", () => ({ getAccountingConfig: m.config }));
vi.mock("@/lib/erp/fiscal", () => ({ loadClosing: m.closing }));
import { loadCierrePage } from "./loadCierre";

// 21 de septiembre de 2026, mediodía en Bogotá.
const NOW = new Date("2026-09-21T17:00:00Z");

beforeEach(() => {
  vi.resetAllMocks();
  m.activeId.mockResolvedValue("r1");
  m.findUnique.mockResolvedValue({ enabledModules: ["accounting"], country: "CO" });
  m.config.mockResolvedValue({ uvtCents: 0, closedThrough: "2026-02", nextVoucherNumber: 8 });
  m.closing.mockResolvedValue({
    year: "2026",
    exists: false,
    dateISO: null,
    resultCents: 0,
    kind: "none",
  });
  m.queryRaw.mockResolvedValue([
    { month: "2026-01", entries: 4, numbered: 4 },
    { month: "2026-03", entries: 2, numbered: 0 },
  ]);
  m.findFirst.mockResolvedValue({ date: new Date("2026-01-15T00:00:00Z") });
});

describe("loadCierrePage — gate", () => {
  it("sin restaurante activo devuelve 'no_restaurant' sin tocar la DB", async () => {
    m.activeId.mockResolvedValue(null);
    await expect(loadCierrePage(undefined, NOW)).resolves.toBe("no_restaurant");
    expect(m.findUnique).not.toHaveBeenCalled();
    expect(m.notFound).not.toHaveBeenCalled();
  });

  it("con el módulo `accounting` apagado la página no existe (notFound)", async () => {
    m.findUnique.mockResolvedValue({ enabledModules: ["inventory"], country: "CO" });
    await expect(loadCierrePage(undefined, NOW)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(m.notFound).toHaveBeenCalledTimes(1);
    expect(m.config).not.toHaveBeenCalled();
  });

  it("restaurante inexistente también es notFound", async () => {
    m.findUnique.mockResolvedValue(null);
    await expect(loadCierrePage(undefined, NOW)).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

describe("loadCierrePage — datos", () => {
  it("arma el año en curso con candado, conteos y próximo mes por cerrar", async () => {
    const d = await loadCierrePage(undefined, NOW);
    if (d === "no_restaurant") throw new Error("gate inesperado");
    expect(d.currency).toBe("COP");
    expect(d.currentYear).toBe(2026);
    expect(d.config).toEqual({ closedThrough: "2026-02", nextVoucherNumber: 8 });
    expect(d.status.year).toBe(2026);
    expect(d.status.nextToClose).toBe("2026-03");
    expect(d.status.months[0]).toMatchObject({ month: "2026-01", closed: true, entries: 4, numbered: 4 });
    expect(d.status.months[2]).toMatchObject({ month: "2026-03", closed: false, entries: 2, canClose: true });
    expect(d.status.months[9]).toMatchObject({ month: "2026-10", future: true, canClose: false });
    expect(d.closing.exists).toBe(false);
    expect(m.closing).toHaveBeenCalledWith("r1", "2026");
  });

  it("respeta ?year= válido y cae al año en curso si es basura", async () => {
    const d = await loadCierrePage("2025", NOW);
    if (d === "no_restaurant") throw new Error("gate inesperado");
    expect(d.status.year).toBe(2025);
    expect(m.closing).toHaveBeenCalledWith("r1", "2025");

    const e = await loadCierrePage("1999", NOW);
    if (e === "no_restaurant") throw new Error("gate inesperado");
    expect(e.status.year).toBe(2026);
  });

  it("sin comprobantes no hay próximo mes por cerrar", async () => {
    m.config.mockResolvedValue({ uvtCents: 0, closedThrough: null, nextVoucherNumber: 1 });
    m.queryRaw.mockResolvedValue([]);
    m.findFirst.mockResolvedValue(null);
    const d = await loadCierrePage(undefined, NOW);
    if (d === "no_restaurant") throw new Error("gate inesperado");
    expect(d.status.nextToClose).toBeNull();
    expect(d.status.months.some((x) => x.canClose)).toBe(false);
  });
});
