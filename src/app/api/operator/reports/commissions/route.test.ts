import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommissionRow } from "@/lib/waiterCommissions";

const m = vi.hoisted(() => ({ ctx: vi.fn(), load: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: m.ctx,
  isDenied: (c: unknown) => typeof c === "object" && c !== null && "error" in c,
}));
vi.mock("@/lib/erp/reports/waiterCommissionQueries", () => ({
  loadSealedCommissions: m.load,
}));
// Las claves salen tal cual (con sus variables): el test verifica
// estructura, no textos.
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}));
import { GET } from "./route";

const DESDE = "2026-09-01";
const HASTA = "2026-09-30";

function row(over: Partial<CommissionRow> & { orderId: string }): CommissionRow {
  return {
    shortCode: over.orderId.toUpperCase(),
    paidAt: "2026-09-10T18:00:00.000Z",
    orderType: "dineIn",
    tableNumber: 5,
    tableLabel: null,
    waiterId: "w-ana",
    waiterName: "Ana",
    bps: 250,
    baseCents: 100_000,
    commissionCents: 2_500,
    ...over,
  };
}

const req = (qs = "") => new Request(`http://localhost/api/operator/reports/commissions${qs}`);

beforeEach(() => {
  vi.resetAllMocks();
  m.ctx.mockResolvedValue({ restaurantId: "restaurant-1", country: "CO", userId: "user-1" });
  m.load.mockResolvedValue([
    row({ orderId: "a1" }),
    row({ orderId: "a2", paidAt: "2026-09-12T20:00:00.000Z", baseCents: 40_000, commissionCents: 1_000 }),
    row({
      orderId: "l1",
      paidAt: "2026-09-05T12:00:00.000Z",
      waiterId: "w-luis",
      waiterName: "Luis",
      bps: 300,
      baseCents: 200_000,
      commissionCents: 6_000,
      orderType: "pickup",
      tableNumber: -1,
    }),
  ]);
});

describe("GET /api/operator/reports/commissions (JSON)", () => {
  it("devuelve período, resumen por persona, detalle por fecha de pago y totales", async () => {
    const res = await GET(req(`?desde=${DESDE}&hasta=${HASTA}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.period).toEqual({ desde: DESDE, hasta: HASTA });
    expect(m.load).toHaveBeenCalledWith("restaurant-1", { desde: DESDE, hasta: HASTA });
    expect(body.summary.map((p: { waiterId: string }) => p.waiterId)).toEqual(["w-luis", "w-ana"]);
    expect(body.summary[1]).toMatchObject({ orders: 2, baseCents: 140_000, bps: 250, commissionCents: 3_500 });
    expect(body.detail.map((r: { orderId: string }) => r.orderId)).toEqual(["l1", "a1", "a2"]);
    expect(body.totals).toEqual({ orders: 3, baseCents: 340_000, commissionCents: 9_500, people: 2 });
  });

  it("sin fechas consulta el mes en curso", async () => {
    const body = await (await GET(req())).json();
    expect(body.period.desde).toMatch(/^\d{4}-\d{2}-01$/);
    expect(body.period.hasta.slice(0, 7)).toBe(body.period.desde.slice(0, 7));
    expect(m.load).toHaveBeenCalledWith("restaurant-1", body.period);
  });

  it("rechaza fechas inválidas, rangos al revés y formatos desconocidos sin consultar", async () => {
    expect((await GET(req("?desde=2026-02-31"))).status).toBe(400);
    expect((await GET(req(`?desde=${HASTA}&hasta=${DESDE}`))).status).toBe(400);
    expect((await GET(req("?format=csv"))).status).toBe(400);
    expect(m.load).not.toHaveBeenCalled();
  });

  it("propaga el rechazo del gate (módulo contable apagado)", async () => {
    m.ctx.mockResolvedValue({ error: "module_disabled", status: 403 });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "module_disabled" });
    expect(m.load).not.toHaveBeenCalled();
  });
});

describe("GET /api/operator/reports/commissions (CSV)", () => {
  it("csv-resumen: nota, encabezados, una fila por persona y TOTAL, con BOM y coma decimal", async () => {
    const res = await GET(req(`?desde=${DESDE}&hasta=${HASTA}&format=csv-resumen`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain(`comisiones-${DESDE}-a-${HASTA}.csv`);
    const buf = Buffer.from(await res.arrayBuffer());
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = buf.toString("utf8").slice(1).split("\r\n");
    expect(lines).toEqual([
      `csvNote:${DESDE},${HASTA}`,
      "colPerson;colOrders;colCollected;colPct;colCommission",
      "Luis;1;2000,00;3,00;60,00",
      "Ana;2;1400,00;2,50;35,00",
      "csvTotal;3;3400,00;;95,00",
    ]);
  });

  it("csv-detalle: cuenta a cuenta por fecha de pago, con la mesa traducida", async () => {
    const res = await GET(req(`?desde=${DESDE}&hasta=${HASTA}&format=csv-detalle`));
    expect(res.headers.get("content-disposition")).toContain(
      `comisiones-detalle-${DESDE}-a-${HASTA}.csv`,
    );
    const lines = (await res.text()).split("\r\n");
    expect(lines).toEqual([
      `csvNote:${DESDE},${HASTA}`,
      "colPaidAt;colAccount;colTable;colPerson;colCollected;colPct;colCommission",
      "2026-09-05;L1;accountPickup;Luis;2000,00;3,00;60,00",
      "2026-09-10;A1;accountTable:5;Ana;1000,00;2,50;25,00",
      "2026-09-12;A2;accountTable:5;Ana;400,00;2,50;10,00",
    ]);
  });
});
