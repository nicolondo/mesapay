// Consultas de la pantalla de facturas electrónicas, con la DB simulada:
// qué se le pide a Prisma (where, orden, página, SIN el snapshot), cómo se
// arma cada fila, el aviso de rechazadas y el caso "llegó después" leído del
// XML aceptado.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
  queryRaw: vi.fn(),
  requestFindMany: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    simpleInvoice: { count: m.count, findMany: m.findMany },
    invoiceRequest: { findMany: m.requestFindMany },
    $queryRaw: m.queryRaw,
  },
}));

import {
  countRecentRejected,
  loadInvoiceListPage,
  loadLateInvoiceRequests,
  LATE_CANDIDATES_LIMIT,
} from "./invoiceListQueries";
import { invoiceListWhere, parseInvoiceListParams } from "./invoiceList";
import { CONSUMIDOR_FINAL_ID } from "./invoiceRequestCoverage";
import { zipInvoice } from "./soap";

function invoiceRow(over: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    orderId: "order-1",
    invoiceNumber: 7845,
    totalCents: 45_000_00,
    createdAt: new Date("2026-10-30T18:05:00.000Z"),
    email: null,
    order: { shortCode: "002A77-77C496", simpleInvoiceEmail: null, invoiceRequests: [{ email: "ana@correo.com" }] },
    dianDocument: {
      id: "doc-1",
      state: "accepted",
      attempts: 1,
      lastError: null,
      errors: null,
      emailedAt: new Date("2026-10-30T18:05:03.000Z"),
      emailError: null,
    },
    creditNotes: [],
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  m.count.mockResolvedValue(0);
  m.findMany.mockResolvedValue([]);
  m.queryRaw.mockResolvedValue([]);
  m.requestFindMany.mockResolvedValue([]);
});

describe("página de la lista", () => {
  it("pide la página a Prisma: where de los filtros, la más nueva primero, 50, sin el snapshot", async () => {
    const params = parseInvoiceListParams({ state: "rejected", from: "2026-10-01", to: "2026-10-31", q: "ana", page: "2" });
    m.count.mockResolvedValue(73);
    const page = await loadInvoiceListPage("rest-1", params, 5);
    const where = invoiceListWhere("rest-1", params, 5);
    expect(m.count).toHaveBeenCalledWith({ where });
    const args = m.findMany.mock.calls[0][0];
    expect(args.where).toEqual(where);
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(args.skip).toBe(50);
    expect(args.take).toBe(50);
    expect(args.select.snapshot).toBeUndefined();
    expect(args.select.dianDocument.select.xmlZip).toBeUndefined();
    expect(page).toMatchObject({ total: 73, page: 2, pageCount: 2, rows: [] });
    // Sin filas no hay consulta de rutas JSON.
    expect(m.queryRaw).not.toHaveBeenCalled();
  });

  it("arma la fila: número con prefijo, consumidor final, correo y nota crédito", async () => {
    m.count.mockResolvedValue(2);
    m.findMany.mockResolvedValue([
      invoiceRow(),
      invoiceRow({
        id: "inv-2",
        invoiceNumber: 7846,
        dianDocument: {
          id: "doc-2",
          state: "rejected",
          attempts: 1,
          lastError: "Regla: FAD06, Rechazo: total errado",
          errors: ["Regla: FAD06, Rechazo: total errado", "Regla: FAJ71"],
          emailedAt: null,
          emailError: null,
        },
        creditNotes: [{ documentNumber: "NC12", dianDocument: { state: "accepted" } }],
      }),
    ]);
    m.queryRaw.mockResolvedValue([
      { id: "inv-1", prefix: "FESM", customerName: null, customerDocType: null, customerDocNumber: null },
      { id: "inv-2", prefix: "FESM", customerName: "Ana Pérez", customerDocType: "CC", customerDocNumber: "1020304050" },
    ]);
    const { rows } = await loadInvoiceListPage("rest-1", parseInvoiceListParams({}), 0);
    expect(rows[0]).toMatchObject({
      id: "inv-1",
      number: "FESM7845",
      customer: null,
      dian: { status: "accepted", reason: null, emailTo: "ana@correo.com", emailedAt: "2026-10-30T18:05:03.000Z" },
      creditNote: null,
    });
    expect(rows[1]).toMatchObject({
      number: "FESM7846",
      customer: { name: "Ana Pérez", docType: "CC", docNumber: "1020304050" },
      dian: { status: "rejected", reason: "Regla: FAD06, Rechazo: total errado" },
      creditNote: { documentNumber: "NC12", state: "accepted" },
    });
    expect(rows[1].dian.errors).toHaveLength(2);
  });
});

describe("aviso de rechazadas", () => {
  it("cuenta las rechazadas de los últimos 30 días operativos con el MISMO where del filtro", async () => {
    m.count.mockResolvedValue(17);
    const now = new Date("2026-10-31T15:00:00.000Z");
    const r = await countRecentRejected("rest-1", 5, now);
    expect(r).toEqual({ count: 17, from: "2026-10-02", to: "2026-10-31" });
    expect(m.count).toHaveBeenCalledWith({
      where: invoiceListWhere("rest-1", { state: "rejected", from: "2026-10-02", to: "2026-10-31", q: "" }, 5),
    });
  });
});

describe("caso 'llegó después' leído del XML aceptado", () => {
  async function xmlZip(buyerId: string, time = "13:05:10-05:00") {
    const xml =
      `<Invoice><cbc:IssueDate>2026-10-30</cbc:IssueDate><cbc:IssueTime>${time}</cbc:IssueTime>` +
      `<cac:AccountingCustomerParty><cac:Party><cac:PartyTaxScheme>` +
      `<cbc:CompanyID schemeName="13">${buyerId}</cbc:CompanyID>` +
      `</cac:PartyTaxScheme></cac:Party></cac:AccountingCustomerParty></Invoice>`;
    return zipInvoice("FESM.xml", xml);
  }
  function candidate(id: string, createdAt: string, invoice: { id: string; zip: Buffer | null }) {
    return {
      id,
      customerName: "Ana Pérez",
      docType: "CC",
      docNumber: "1020304050",
      email: "ana@correo.com",
      createdAt: new Date(createdAt),
      order: {
        shortCode: "002A77-77C496",
        simpleInvoice: {
          id: invoice.id,
          invoiceNumber: 7845,
          dianDocument: { xmlZip: invoice.zip },
          creditNotes: [],
        },
      },
    };
  }

  it("aparece sólo la que llegó después de una factura a consumidor final", async () => {
    // Emitida 13:05:10 Bogotá = 18:05:10Z.
    const cf = { id: "inv-cf", zip: await xmlZip(CONSUMIDOR_FINAL_ID) };
    const nominal = { id: "inv-ana", zip: await xmlZip("1020304050") };
    m.requestFindMany.mockResolvedValue([
      candidate("tarde", "2026-10-30T18:30:00.000Z", cf),
      candidate("antes", "2026-10-30T18:00:00.000Z", cf),
      candidate("nominativa", "2026-10-30T18:30:00.000Z", nominal),
      candidate("sin-xml", "2026-10-30T18:30:00.000Z", { id: "inv-x", zip: null }),
    ]);
    m.queryRaw.mockResolvedValue([{ id: "inv-cf", prefix: "FESM" }]);
    const { items, truncated } = await loadLateInvoiceRequests("rest-1");
    expect(items.map((i) => i.id)).toEqual(["tarde"]);
    expect(items[0]).toMatchObject({
      invoiceId: "inv-cf",
      invoiceNumber: "FESM7845",
      issuedAt: "2026-10-30T18:05:10.000Z",
      requestedAt: "2026-10-30T18:30:00.000Z",
    });
    expect(truncated).toBe(false);
  });

  it("sólo mira solicitudes pendientes del comercio con factura aceptada, las más nuevas primero", async () => {
    await loadLateInvoiceRequests("rest-1");
    const args = m.requestFindMany.mock.calls[0][0];
    expect(args.where).toEqual({
      restaurantId: "rest-1",
      status: "pending",
      order: { simpleInvoice: { is: { dianDocument: { is: { kind: "invoice", state: "accepted" } } } } },
    });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
    expect(args.take).toBe(LATE_CANDIDATES_LIMIT);
  });
});
