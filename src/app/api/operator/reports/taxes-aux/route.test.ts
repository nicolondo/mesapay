import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RetentionLedgerLine } from "@/lib/erp/reports/taxesDetail";
import type { PurchaseTaxInput, SaleTaxInput } from "@/lib/erp/reports/taxesDocuments";
import type { TaxAccount } from "@/lib/erp/reports/taxesModel";
import type { EngineEntry, EngineOrder } from "@/lib/erp/reports/taxesReconcile";

/**
 * `GET /api/operator/reports/taxes-aux` — los auxiliares del despliegue:
 *   1. el gate corta antes de consultar;
 *   2. la query se valida (fechas, nodo, página, tamaño, formato);
 *   3. el período llega a las consultas (mismos filtros que la página);
 *   4. el JSON pagina y `totals` suma TODAS las filas = el renglón;
 *   5. un nodo desconocido es 404; una revisión trae sus filas;
 *   6. CSV y Excel del renglón y de todo el despliegue.
 * Las capas de consultas están mockeadas: se prueba la ruta y la composición.
 */
const h = vi.hoisted(() => {
  const state = {
    ctx: { restaurantId: "r1", country: "CO", userId: "u1" } as
      | { restaurantId: string; country: string; userId: string }
      | { error: string; status: number },
    sales: [] as SaleTaxInput[],
    purchases: [] as PurchaseTaxInput[],
    lines: [] as RetentionLedgerLine[],
    accounts: [] as TaxAccount[],
    orders: [] as EngineOrder[],
    entries: [] as EngineEntry[],
    calls: [] as { fn: string; from: string; to: string }[],
  };
  const track = (fn: string, from: Date, to: Date) => state.calls.push({ fn, from: from.toISOString(), to: to.toISOString() });
  return {
    state,
    getErpContext: vi.fn(async () => state.ctx),
    loadSaleTaxDocs: vi.fn(async (_r: string, from: Date, to: Date) => {
      track("sales", from, to);
      return state.sales.filter((s) => Date.parse(s.dateIso) >= from.getTime() && Date.parse(s.dateIso) < to.getTime());
    }),
    loadPurchaseTaxDocs: vi.fn(async (_r: string, from: Date, to: Date) => {
      track("purchases", from, to);
      return state.purchases;
    }),
    loadTaxLedgerLines: vi.fn(async (_r: string, from: Date, to: Date) => {
      track("ledger", from, to);
      return state.lines;
    }),
  };
});

vi.mock("@/lib/secureApi", () => ({ secureApi: (handler: unknown) => handler }));
vi.mock("@/lib/billing/countries", () => ({ getCurrencyForCountry: async () => "COP" }));
vi.mock("@/lib/erp/access", () => ({
  getErpContext: h.getErpContext,
  isDenied: (ctx: unknown) => typeof ctx === "object" && ctx !== null && "error" in ctx,
}));
vi.mock("@/lib/erp/reports/taxesQueries", () => ({
  loadSaleTaxDocs: h.loadSaleTaxDocs,
  loadPurchaseTaxDocs: h.loadPurchaseTaxDocs,
  loadCreditNoteTaxDocs: vi.fn(async () => []),
  loadRefundsCents: vi.fn(async () => 0),
  loadCurrentSalesTax: vi.fn(async () => ({ kind: "inc", pct: 8 })),
  loadTaxAccounts: vi.fn(async () => h.state.accounts),
  loadTaxLedgerLines: h.loadTaxLedgerLines,
  // Facturas emitidas antes de cobrar y sin cobrar: ninguna en estos casos.
  loadPendingPaymentSaleDocs: vi.fn(async () => []),
}));
vi.mock("@/lib/erp/reports/taxesDrillQueries", () => ({
  loadDrillTenant: vi.fn(async () => ({
    cutoffHour: 5,
    purchaseIvaDeductible: false,
    salesTaxKind: "inc",
    salesTaxPct: 8,
    uvtCents: 5_237_400,
  })),
  loadRetentionConceptsFull: vi.fn(async () => []),
  loadEngineOrders: vi.fn(async () => ({ orders: h.state.orders, freeLineTaxByInvoice: new Map() })),
  loadEngineEntries: vi.fn(async () => h.state.entries),
  loadDianInvoiceStates: vi.fn(async () => new Map([["i2", { state: "rejected", lastError: "FAK24" }]])),
  loadDianCreditNotes: vi.fn(async () => []),
  loadSaleTaxTrendDocs: vi.fn(async () => []),
}));
vi.mock("next-intl/server", () => ({
  getLocale: vi.fn(async () => "es"),
  getTranslations: vi.fn(async (ns: string) => {
    const t = (key: string, params?: Record<string, unknown>) =>
      params ? `[${ns}.${key} ${Object.values(params).join("|")}]` : `[${ns}.${key}]`;
    t.has = () => true;
    return t;
  }),
}));

import { clearTaxesDrillCache } from "@/lib/erp/reports/taxesDrillReport";
import { GET } from "./route";

function get(query: string): Promise<Response> {
  const req = new Request(`http://localhost/api/operator/reports/taxes-aux${query}`);
  return (GET as unknown as (r: Request) => Promise<Response>)(req);
}

const sale = (i: number, day: string, tax: number): SaleTaxInput => ({
  invoiceId: `i${i}`,
  document: `FE${i}`,
  dateIso: `${day}T20:00:00.000Z`,
  taxKind: "inc",
  taxPct: 8,
  baseCents: tax * 12.5,
  taxCents: tax,
  customer: null,
});

beforeEach(() => {
  clearTaxesDrillCache();
  h.state.ctx = { restaurantId: "r1", country: "CO", userId: "u1" };
  h.state.calls = [];
  h.state.sales = Array.from({ length: 7 }, (_, i) => sale(i + 1, `2026-08-${String(i + 2).padStart(2, "0")}`, 800 * (i + 1)));
  h.state.purchases = [];
  h.state.accounts = [{ code: "241205", name: "INC", type: "pasivo" }];
  h.state.lines = [
    {
      id: "l1",
      entryId: "e-m",
      accountCode: "241205",
      debitCents: 0,
      creditCents: 1_000,
      dateIso: "2026-08-20T05:00:00.000Z",
      voucherNumber: 12,
      source: "manual",
      status: "posted",
    },
  ];
  h.state.orders = h.state.sales.map((s) => ({
    orderId: `o-${s.invoiceId}`,
    shortCode: null,
    paidAtIso: s.dateIso,
    status: "paid",
    invoiceId: s.invoiceId,
    slice: { kind: "inc" as const, pct: 8, baseCents: s.baseCents, taxCents: s.taxCents },
  }));
  h.state.entries = [{ id: "e-2026-08-02", source: "sale", day: "2026-08-02", voucher: null }];
});

describe("gate y validación", () => {
  it("sin acceso corta antes de consultar", async () => {
    h.state.ctx = { error: "forbidden", status: 403 };
    const r = await get("?desde=2026-08-01&hasta=2026-08-31&nodo=inc-ventas-8");
    expect(r.status).toBe(403);
    expect(h.state.calls).toEqual([]);
  });

  it.each([
    "?desde=2026-08-01&hasta=2026-08-31",
    "?desde=2026-08-01&hasta=2026-08-31&nodo=inc%20ventas",
    "?desde=2026-02-31&nodo=inc-ventas-8",
    "?desde=2026-08-01&hasta=2026-08-31&nodo=inc-ventas-8&size=500",
    "?desde=2026-08-01&hasta=2026-08-31&nodo=inc-ventas-8&page=0",
    "?desde=2026-08-01&hasta=2026-08-31&nodo=inc-ventas-8&format=pdf",
    "?desde=2026-08-01&hasta=2026-08-31&nodo=todo",
    "?desde=2026-08-31&hasta=2026-08-01&nodo=inc-ventas-8",
  ])("400 con %s", async (q) => {
    expect((await get(q)).status).toBe(400);
  });

  it("nodo desconocido → 404", async () => {
    expect((await get("?desde=2026-08-01&hasta=2026-08-31&nodo=iva-ventas-19")).status).toBe(404);
  });
});

describe("JSON paginado", () => {
  it("las filas de un renglón documental, con su asiento y la marca DIAN; totals de todas las filas", async () => {
    const r = await get("?desde=2026-08-01&hasta=2026-08-31&nodo=inc-ventas-8&size=3&page=1");
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ node: "inc-ventas-8", kind: "docs", page: 1, pages: 3, size: 3, total: 7 });
    expect(j.totals).toEqual({ count: 7, amountCents: 800 * 28, baseCents: 800 * 28 * 12.5 });
    expect(j.rows.map((x: { docId: string }) => x.docId)).toEqual(["i1", "i2", "i3"]);
    expect(j.rows[0]).toMatchObject({ kind: "doc", entryId: "e-2026-08-02", document: "FE1" });
    expect(j.rows[1].flags).toEqual(["dianRejected", "noEntry"]);
  });

  it("la página pedida de más se acota a la última", async () => {
    const j = await (await get("?desde=2026-08-01&hasta=2026-08-31&nodo=inc-ventas-8&size=3&page=9")).json();
    expect(j.page).toBe(3);
    expect(j.rows).toHaveLength(1);
  });

  it("el período llega a las consultas: ventas y compras hasta el fin del último día de negocio", async () => {
    await get("?desde=2026-08-01&hasta=2026-08-31&nodo=inc-ventas-8");
    expect(h.state.calls.find((c) => c.fn === "sales")).toEqual({
      fn: "sales",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-09-01T10:00:00.000Z",
    });
    expect(h.state.calls.find((c) => c.fn === "ledger")).toEqual({
      fn: "ledger",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
    });
  });

  it("las líneas del libro de un renglón y las filas de una revisión", async () => {
    const book = await (await get("?desde=2026-08-01&hasta=2026-08-31&nodo=inc-libro-manual")).json();
    expect(book).toMatchObject({ kind: "ledger", total: 1, totals: { amountCents: 1_000 } });
    expect(book.rows[0]).toMatchObject({ voucher: "#000012", source: "manual" });
    const check = await (await get("?desde=2026-08-01&hasta=2026-08-31&nodo=alerta-dianRechazada")).json();
    expect(check).toMatchObject({ kind: "check", total: 1 });
    expect(check.rows[0]).toMatchObject({ docId: "i2", memo: "FAK24" });
    expect((await get("?desde=2026-08-01&hasta=2026-08-31&nodo=alerta-noExiste")).status).toBe(404);
  });

  it("la segunda consulta del mismo período sale de la caché (misma foto que la página)", async () => {
    await get("?desde=2026-08-01&hasta=2026-08-31&nodo=inc-ventas-8");
    const before = h.state.calls.length;
    await get("?desde=2026-08-01&hasta=2026-08-31&nodo=inc-libro-manual");
    expect(h.state.calls.length).toBe(before);
  });
});

describe("exportación", () => {
  it("CSV de un renglón con BOM, `;` y coma decimal", async () => {
    const r = await get("?desde=2026-08-01&hasta=2026-08-31&nodo=inc-ventas-8&format=csv");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Disposition")).toBe(
      'attachment; filename="impuestos-auxiliares-2026-08-01-a-2026-08-31-inc-ventas-8.csv"',
    );
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const body = new TextDecoder().decode(bytes);
    expect(body).toContain("[opImpuestosRep.xlsxAux]");
    expect(body).toContain("FE1;");
    expect(body).toContain(";8,00;");
  });

  it("Excel de todo el despliegue: resumen, documentos, libro y revisiones", async () => {
    const r = await get("?desde=2026-08-01&hasta=2026-08-31&nodo=todo&format=xlsx");
    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Type")).toContain("spreadsheetml");
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await r.arrayBuffer()) as unknown as ArrayBuffer);
    // Excel no admite «[]» en el nombre de la hoja: el rótulo de prueba sale sin ellos.
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "opImpuestosRep.xlsxSummary",
      "opImpuestosRep.xlsxDocs",
      "opImpuestosRep.xlsxLedger",
      "opImpuestosRep.xlsxChecks",
    ]);
    expect(wb.worksheets[1]!.rowCount).toBe(8);
  });
});
