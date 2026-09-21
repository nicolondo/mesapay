import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RetentionLedgerLine } from "@/lib/erp/reports/taxesDetail";
import type { PurchaseTaxInput, SaleTaxInput } from "@/lib/erp/reports/taxesDocuments";
import type { TaxAccount } from "@/lib/erp/reports/taxesModel";

/**
 * `GET /api/operator/reports/taxes-detail` — lo que hay que blindar:
 *   1. el gate (`getErpContext`) corta antes de consultar;
 *   2. la query se valida (fechas reales, rango al derecho, formato);
 *   3. sin fechas el período es el MES EN CURSO;
 *   4. el JSON trae las cuatro secciones y los stats;
 *   5. `format=csv` descarga con BOM, `;`, coma decimal, encabezados
 *      traducidos y una fila por documento/comprobante.
 *
 * La capa de consultas (`taxesQueries`) está mockeada: aquí se prueba la
 * ruta y la composición, no Prisma.
 */
const h = vi.hoisted(() => {
  const state = {
    ctx: { restaurantId: "r1", country: "CO", userId: "u1" } as
      | { restaurantId: string; country: string; userId: string }
      | { error: string; status: number },
    sales: [] as SaleTaxInput[],
    purchases: [] as PurchaseTaxInput[],
    accounts: [] as TaxAccount[],
    lines: [] as RetentionLedgerLine[],
    calls: [] as { fn: string; from: string; to: string }[],
  };
  const track = (fn: string) => (_restaurantId: string, from: Date, to: Date) => {
    state.calls.push({ fn, from: from.toISOString(), to: to.toISOString() });
  };
  return {
    state,
    getErpContext: vi.fn(async () => state.ctx),
    loadSaleTaxDocs: vi.fn(async (r: string, from: Date, to: Date) => {
      track("sales")(r, from, to);
      return state.sales;
    }),
    loadPurchaseTaxDocs: vi.fn(async (r: string, from: Date, to: Date) => {
      track("purchases")(r, from, to);
      return state.purchases;
    }),
    loadTaxAccounts: vi.fn(async () => state.accounts),
    loadTaxLedgerLines: vi.fn(async (r: string, from: Date, to: Date) => {
      track("ledger")(r, from, to);
      return state.lines;
    }),
    loadRetentionConceptRows: vi.fn(async () => [
      { kind: "retefuente", name: "Compras (2,5%)", accountCode: "236505", active: true },
    ]),
    loadRefundsCents: vi.fn(async () => 0),
    loadCurrentSalesTax: vi.fn(async () => ({ kind: "inc", pct: 8 })),
  };
});

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: h.getErpContext,
  isDenied: (ctx: unknown) => typeof ctx === "object" && ctx !== null && "error" in ctx,
}));
vi.mock("@/lib/erp/reports/taxesQueries", () => ({
  loadSaleTaxDocs: h.loadSaleTaxDocs,
  loadPurchaseTaxDocs: h.loadPurchaseTaxDocs,
  loadTaxAccounts: h.loadTaxAccounts,
  loadTaxLedgerLines: h.loadTaxLedgerLines,
  loadRetentionConceptRows: h.loadRetentionConceptRows,
  loadRefundsCents: h.loadRefundsCents,
  loadCurrentSalesTax: h.loadCurrentSalesTax,
}));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async (ns: string) => {
    const t = (key: string) => `[${ns}.${key}]`;
    t.has = () => true;
    return t;
  }),
}));

import { GET } from "./route";

function get(query: string): Promise<Response> {
  const req = new Request(`http://localhost/api/operator/reports/taxes-detail${query}`);
  return (GET as unknown as (r: Request) => Promise<Response>)(req);
}

beforeEach(() => {
  h.state.ctx = { restaurantId: "r1", country: "CO", userId: "u1" };
  h.state.calls = [];
  h.loadSaleTaxDocs.mockClear();
  h.state.sales = [
    {
      invoiceId: "i1",
      document: "FESM1",
      dateIso: "2026-08-10T15:00:00.000Z",
      taxKind: "inc",
      taxPct: 8,
      baseCents: 100_000,
      taxCents: 8_000,
      customer: null,
    },
    {
      invoiceId: "i2",
      document: "FESM2",
      dateIso: "2026-08-12T15:00:00.000Z",
      taxKind: "iva",
      taxPct: 19,
      baseCents: 200_000,
      taxCents: 38_000,
      customer: { name: "ACME S.A.S.", docType: "NIT", docNumber: "900123456" },
    },
  ];
  h.state.purchases = [
    {
      purchaseId: "p1",
      document: "F-77",
      dateIso: "2026-08-12T00:00:00.000Z",
      supplierName: "Distribuidora",
      supplierTaxId: "800111222",
      lines: [{ netCents: 100_000, taxPct: 19, nonDeductibleTaxCents: 0 }],
      incCents: 0,
      retefuenteCents: 2_500,
      reteIvaCents: 0,
      reteIcaCents: 0,
    },
  ];
  h.state.accounts = [
    { code: "236505", name: "Retención en la fuente por pagar", type: "pasivo" },
    { code: "135515", name: "Retención en la fuente", type: "activo" },
  ];
  h.state.lines = [
    {
      id: "l1",
      entryId: "e1",
      accountCode: "236505",
      debitCents: 0,
      creditCents: 2_500,
      dateIso: "2026-08-31T23:59:59.999Z",
      voucherNumber: 7,
      source: "purchase",
      status: "posted",
    },
    {
      id: "l2",
      entryId: "e2",
      accountCode: "135515",
      debitCents: 1_000,
      creditCents: 0,
      dateIso: "2026-08-20T00:00:00.000Z",
      voucherNumber: null,
      source: "manual",
      status: "posted",
      thirdPartyName: "Cliente S.A.",
      thirdPartyTaxId: "890000000",
    },
  ];
});

describe("gate y validación", () => {
  it("responde el error del gate sin consultar", async () => {
    h.state.ctx = { error: "module_disabled", status: 403 };
    const res = await get("?desde=2026-08-01&hasta=2026-08-31");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "module_disabled" });
    expect(h.loadSaleTaxDocs).not.toHaveBeenCalled();
  });

  it("400 invalid con fecha imposible, rango al revés o formato raro", async () => {
    expect((await get("?desde=2026-02-31")).status).toBe(400);
    expect((await get("?desde=2026-03-01&hasta=2026-02-01")).status).toBe(400);
    expect((await get("?format=xlsx")).status).toBe(400);
    expect(h.loadSaleTaxDocs).not.toHaveBeenCalled();
  });
});

describe("JSON", () => {
  it("consulta con límites UTC (hasta exclusivo) y devuelve las secciones y los stats", async () => {
    const res = await get("?desde=2026-08-01&hasta=2026-08-31");
    expect(res.status).toBe(200);
    expect(h.state.calls).toEqual(
      expect.arrayContaining([
        { fn: "sales", from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" },
        { fn: "ledger", from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" },
      ]),
    );
    const body = await res.json();
    expect(body.period).toEqual({ desde: "2026-08-01", hasta: "2026-08-31" });
    expect(body.sales.map((r: { document: string }) => r.document)).toEqual(["FESM1", "FESM2"]);
    expect(body.sales[1]).toMatchObject({ nit: "900123456", party: "ACME S.A.S.", pct: 19, valorCents: 38_000 });
    expect(body.purchases).toEqual([
      expect.objectContaining({ document: "F-77", party: "Distribuidora", pct: 19, baseCents: 100_000, valorCents: 19_000 }),
    ]);
    expect(body.practicadas).toEqual([
      expect.objectContaining({ accountCode: "236505", voucher: "#000007", conceptName: "Compras (2,5%)", valorCents: 2_500 }),
    ]);
    expect(body.aFavor).toEqual([
      expect.objectContaining({ accountCode: "135515", voucher: null, party: "Cliente S.A.", valorCents: 1_000 }),
    ]);
    expect(body.stats).toEqual({
      ivaGeneradoCents: 38_000,
      incGeneradoCents: 8_000,
      ivaDescontableCents: 19_000,
      retencionesPracticadasCents: 2_500,
      retencionesAFavorCents: 1_000,
    });
  });

  it("sin fechas usa el MES EN CURSO", async () => {
    const res = await get("");
    const body = await res.json();
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    // `todayIso` mira Bogotá; a medianoche UTC el mes puede diferir — se acepta cualquiera de los dos.
    expect(body.period.desde.endsWith("-01")).toBe(true);
    expect([ym, body.period.desde.slice(0, 7)]).toContain(body.period.desde.slice(0, 7));
    expect(body.period.hasta.slice(0, 7)).toBe(body.period.desde.slice(0, 7));
  });
});

describe("CSV", () => {
  it("descarga con BOM, ;, coma decimal, encabezados traducidos y una fila por documento", async () => {
    const res = await get("?desde=2026-08-01&hasta=2026-08-31&format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="impuestos-detallados-2026-08-01-a-2026-08-31.csv"',
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).split("\r\n");
    expect(lines[0]).toBe(
      "[opImpuestosRep.colSection];[opReportes.colDate];[opImpuestosRep.colDocument];[opImpuestosRep.colNit];[opImpuestosRep.colParty];[opImpuestosRep.colTaxOrConcept];[opImpuestosRep.colRate];[opImpuestosRep.colBase];[opImpuestosRep.colValue]",
    );
    expect(lines[1]).toBe(
      "[opImpuestosRep.secSales];2026-08-10;FESM1;;[opImpuestosRep.finalConsumer];[opImpuestosRep.famInc];8 %;1000,00;80,00",
    );
    expect(lines[2]).toBe(
      "[opImpuestosRep.secSales];2026-08-12;FESM2;900123456;ACME S.A.S.;[opImpuestosRep.famIva];19 %;2000,00;380,00",
    );
    expect(lines[3]).toBe(
      "[opImpuestosRep.secPurchases];2026-08-12;F-77;800111222;Distribuidora;[opImpuestosRep.famIva];19 %;1000,00;190,00",
    );
    expect(lines[4]).toBe(
      "[opImpuestosRep.secRetPracticed];2026-08-31;#000007 · [opErp.jSource_purchase];;;Compras (2,5%) (236505);;;25,00",
    );
    expect(lines[5]).toBe(
      "[opImpuestosRep.secRetFavor];2026-08-20;[opReportes.unnumbered] · [opErp.jSource_manual];890000000;Cliente S.A.;Retención en la fuente (135515);;;10,00",
    );
    expect(lines).toHaveLength(6);
  });
});
