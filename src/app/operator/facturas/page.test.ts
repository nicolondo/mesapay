// La pantalla /operator/facturas tiene dos caras según el módulo
// `einvoicing`. Este archivo fija la de SIN módulo: el flujo manual de
// solicitudes (Pendientes / Ya generadas, copiar datos, marcar generada /
// rechazar / reabrir) tiene que verse EXACTAMENTE como antes de que existiera
// la vista de facturas electrónicas. El snapshot se generó con el código
// anterior al cambio y no se regenera: si este test falla, cambió lo que ve
// un comercio sin facturación electrónica.
process.env.TZ = "America/Bogota";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import es from "../../../../messages/es.json";

const m = vi.hoisted(() => ({
  restaurantFindUnique: vi.fn(),
  requestFindMany: vi.fn(),
  pendingEmissionSummary: vi.fn(),
  simpleInvoiceFindMany: vi.fn(),
  simpleInvoiceCount: vi.fn(),
  loadInvoiceListPage: vi.fn(),
  countRecentRejected: vi.fn(),
  loadLateInvoiceRequests: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: m.restaurantFindUnique },
    invoiceRequest: { findMany: m.requestFindMany },
    simpleInvoice: { findMany: m.simpleInvoiceFindMany, count: m.simpleInvoiceCount },
  },
}));
vi.mock("@/lib/activeRestaurant", () => ({ getActiveRestaurantId: async () => "rest-1" }));
vi.mock("@/lib/dian/pendingEmission", () => ({ pendingEmissionSummary: m.pendingEmissionSummary }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: "es", messages: es, namespace: namespace as never }),
  getLocale: async () => "es",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
// Las consultas de la vista de facturas electrónicas tienen su propio test
// (lib/dian/invoiceListQueries.test.ts); acá se mira qué se les pide y qué
// se muestra con lo que devuelven.
vi.mock("@/lib/dian/invoiceListQueries", () => ({
  loadInvoiceListPage: m.loadInvoiceListPage,
  countRecentRejected: m.countRecentRejected,
  loadLateInvoiceRequests: m.loadLateInvoiceRequests,
}));

import FacturasPage from "./page";

const NOW = new Date("2026-10-31T15:00:00.000Z");

// Dos pendientes (una con tirilla —botón del datáfono— y una vieja con
// dirección) y una ya generada.
const PENDING = [
  {
    id: "req-1",
    customerName: "Ana Pérez",
    docType: "CC",
    docNumber: "1020304050",
    address: null,
    city: null,
    department: null,
    email: "ana@correo.com",
    notes: null,
    createdAt: new Date("2026-10-31T14:20:00.000Z"),
    order: {
      shortCode: "002A77-77C496-58E6EF-6C25C8",
      totalCents: 45_000_00,
      paidAt: new Date("2026-10-31T14:00:00.000Z"),
      simpleInvoiceEmail: null,
      invoiceRequests: [{ email: "ana@correo.com" }],
      simpleInvoice: {
        id: "inv-1",
        email: "ana@correo.com",
        dianDocument: null,
      },
    },
  },
  {
    id: "req-2",
    customerName: "Ferretería El Tornillo S.A.S.",
    docType: "NIT",
    docNumber: "900123456",
    address: "Calle 10 # 20-30",
    city: "Envigado",
    department: "Antioquia",
    email: "compras@tornillo.co",
    notes: null,
    createdAt: new Date("2026-10-29T18:00:00.000Z"),
    order: {
      shortCode: "B3C4D5-000000-000000-000000",
      totalCents: 120_500_00,
      paidAt: null,
      simpleInvoiceEmail: null,
      invoiceRequests: [{ email: "compras@tornillo.co" }],
      simpleInvoice: null,
    },
  },
];

const GENERATED = [
  {
    id: "req-3",
    customerName: "Carlos Gómez",
    docType: "CE",
    docNumber: "998877",
    address: null,
    city: "Medellín",
    department: "Antioquia",
    email: "carlos@correo.com",
    notes: null,
    createdAt: new Date("2026-10-20T16:00:00.000Z"),
    generatedAt: new Date("2026-10-20T19:30:00.000Z"),
    generatedByEmail: "caja@sonymelona.com",
    order: {
      shortCode: "C0FFEE-000000-000000-000000",
      totalCents: 80_000_00,
      paidAt: new Date("2026-10-20T15:50:00.000Z"),
      simpleInvoiceEmail: null,
      invoiceRequests: [{ email: "carlos@correo.com" }],
      simpleInvoice: { id: "inv-3", email: null, dianDocument: null },
    },
  },
];

function render(el: ReactElement): string {
  const intl = {
    locale: "es",
    timeZone: "America/Bogota",
    messages: es,
  } as unknown as ComponentProps<typeof NextIntlClientProvider>;
  return renderToStaticMarkup(createElement(NextIntlClientProvider, intl, el));
}

async function renderPage(status?: string): Promise<string> {
  const el = await FacturasPage({ searchParams: Promise.resolve(status ? { status } : {}) });
  return render(el as ReactElement);
}

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  vi.clearAllMocks();
  m.restaurantFindUnique.mockResolvedValue({ enabledModules: ["inventory"], businessDayCutoffHour: 5 });
  m.requestFindMany.mockImplementation(async (args: { where: { status: string } }) =>
    args.where.status === "pending" ? PENDING : GENERATED,
  );
});

describe("/operator/facturas SIN facturación electrónica: idéntica a antes", () => {
  it("pestaña Pendientes: mismo HTML que el flujo manual de siempre", async () => {
    const html = await renderPage();
    expect(html).toMatchSnapshot();
    expect(html).toContain("Copiar datos");
    expect(html).toContain("✓ Marcar como generada");
    expect(html).not.toContain("Notas crédito");
  });

  it("pestaña Ya generadas: mismo HTML que el flujo manual de siempre", async () => {
    const html = await renderPage("generated");
    expect(html).toMatchSnapshot();
    expect(html).toContain("Marcar como pendiente de nuevo");
  });

  it("no consulta nada de la DIAN ni la lista de facturas electrónicas", async () => {
    await renderPage();
    expect(m.pendingEmissionSummary).not.toHaveBeenCalled();
    expect(m.simpleInvoiceFindMany).not.toHaveBeenCalled();
    expect(m.simpleInvoiceCount).not.toHaveBeenCalled();
    // Las mismas dos consultas de siempre: pendientes y las 100 últimas generadas.
    const wheres = m.requestFindMany.mock.calls.map(([args]) => args.where);
    expect(wheres).toEqual([
      { restaurantId: "rest-1", status: "pending" },
      { restaurantId: "rest-1", status: "generated" },
    ]);
    const generatedCall = m.requestFindMany.mock.calls[1][0];
    expect(generatedCall.orderBy).toEqual({ generatedAt: "desc" });
    expect(generatedCall.take).toBe(100);
  });
});

// ── CON facturación electrónica ─────────────────────────────────────────────

const ROWS = [
  {
    id: "inv-1",
    orderId: "order-1",
    number: "FESM7845",
    shortCode: "002A77-77C496-58E6EF-6C25C8",
    createdAt: "2026-10-30T18:05:00.000Z",
    customer: null,
    totalCents: 45_000_00,
    dian: {
      documentId: "doc-1",
      state: "accepted",
      status: "accepted",
      reason: null,
      errors: [],
      emailedAt: "2026-10-30T18:05:03.000Z",
      emailError: null,
      emailTo: "ana@correo.com",
    },
    creditNote: null,
  },
  {
    id: "inv-2",
    orderId: "order-2",
    number: "FESM7846",
    shortCode: "B3C4D5-000000-000000-000000",
    createdAt: "2026-10-30T19:00:00.000Z",
    customer: { name: "Ferretería El Tornillo S.A.S.", docType: "NIT", docNumber: "900123456" },
    totalCents: 120_500_00,
    dian: {
      documentId: "doc-2",
      state: "rejected",
      status: "rejected",
      reason: "Regla: FAD06, Rechazo: el total no cuadra",
      errors: ["Regla: FAD06, Rechazo: el total no cuadra"],
      emailedAt: null,
      emailError: null,
      emailTo: "compras@tornillo.co",
    },
    creditNote: { documentNumber: "NC12", state: "accepted" },
  },
];

const LATE = {
  truncated: false,
  items: [
    {
      id: "req-late",
      customerName: "Carlos Gómez",
      docType: "CC",
      docNumber: "998877",
      email: "carlos@correo.com",
      requestedAt: "2026-10-30T18:40:00.000Z",
      invoiceId: "inv-cf",
      invoiceNumber: "FESM7840",
      shortCode: "C0FFEE-000000-000000-000000",
      issuedAt: "2026-10-30T18:05:10.000Z",
      creditNote: null,
    },
  ],
};

describe("/operator/facturas CON facturación electrónica: lista de facturas", () => {
  beforeEach(() => {
    m.restaurantFindUnique.mockResolvedValue({ enabledModules: ["einvoicing"], businessDayCutoffHour: 5 });
    m.pendingEmissionSummary.mockResolvedValue({ waiting: 0, blockedBy: null, blockedCount: 0, numbersLeft: 2156 });
    m.loadInvoiceListPage.mockResolvedValue({ rows: ROWS, total: 73, page: 1, pageCount: 2 });
    m.countRecentRejected.mockResolvedValue({ count: 17, from: "2026-10-02", to: "2026-10-31" });
    m.loadLateInvoiceRequests.mockResolvedValue(LATE);
  });

  async function renderOn(sp: Record<string, string> = {}) {
    const el = await FacturasPage({ searchParams: Promise.resolve(sp) });
    return render(el as ReactElement);
  }

  it("ya no hay flujo manual: ni pestañas Pendientes/Generadas ni copiar datos", async () => {
    const html = await renderOn();
    expect(html).toContain("Facturas electrónicas");
    expect(html).not.toContain("Ya generadas");
    expect(html).not.toContain("Copiar datos");
    expect(html).not.toContain("Marcar como generada");
    expect(m.requestFindMany).not.toHaveBeenCalled();
  });

  it("los filtros de la URL llegan a la consulta, con el corte de día operativo del comercio", async () => {
    await renderOn({ state: "rejected", from: "2026-10-01", to: "2026-10-31", q: "tornillo", page: "2" });
    expect(m.loadInvoiceListPage).toHaveBeenCalledWith(
      "rest-1",
      { state: "rejected", from: "2026-10-01", to: "2026-10-31", q: "tornillo", page: 2 },
      5,
    );
    expect(m.countRecentRejected).toHaveBeenCalledWith("rest-1", 5);
    expect(m.loadLateInvoiceRequests).toHaveBeenCalledWith("rest-1");
  });

  it("muestra cada factura: número, cliente o consumidor final, estado DIAN con motivo, correo y nota crédito", async () => {
    const html = await renderOn();
    expect(html).toContain("FESM7845");
    expect(html).toContain("Consumidor final");
    expect(html).toContain("Ferretería El Tornillo S.A.S.");
    expect(html).toContain("900123456");
    expect(html).toContain("Aceptada");
    expect(html).toContain("Rechazada");
    expect(html).toContain("Regla: FAD06, Rechazo: el total no cuadra");
    expect(html).toContain("Enviada a ana@correo.com");
    expect(html).toContain("NC12 · Aceptada");
  });

  it("acciones: ver / reimprimir / reenviar de siempre, anular con nota crédito preseleccionada y reintentar con advertencia", async () => {
    const html = await renderOn();
    expect(html).toContain('href="/factura/inv-1"');
    expect(html).toContain("Reimprimir factura");
    expect(html).toContain("Reenviar por correo");
    expect(html).toContain('href="/operator/facturas/notas-credito?factura=inv-1"');
    // La rechazada no se anula (no es fiscal): se reintenta, con su advertencia.
    expect(html).not.toContain('href="/operator/facturas/notas-credito?factura=inv-2"');
    expect(html).toContain("Reintentar emisión");
    expect(html).toContain("La DIAN ya rechazó esta factura.");
  });

  it("aviso de rechazadas en 30 días con enlace a su filtro", async () => {
    const html = await renderOn();
    expect(html).toContain("17 facturas rechazadas en los últimos 30 días.");
    expect(html).toContain('href="/operator/facturas?state=rejected&amp;from=2026-10-02&amp;to=2026-10-31"');
  });

  it("aviso 'llegó después': datos del cliente, anular con nota crédito y marcar como resuelta", async () => {
    const html = await renderOn();
    expect(html).toContain(
      "1 cliente pidió factura con sus datos después de que se emitió a consumidor final",
    );
    expect(html).toContain("Carlos Gómez");
    expect(html).toContain("998877");
    expect(html).toContain("carlos@correo.com");
    expect(html).toContain('href="/operator/facturas/notas-credito?factura=inv-cf"');
    expect(html).toContain("Anular y emitir nota crédito");
    expect(html).toContain("Marcar como resuelta");
  });

  it("sin rechazadas ni casos tardíos, no hay avisos", async () => {
    m.countRecentRejected.mockResolvedValue({ count: 0, from: "2026-10-02", to: "2026-10-31" });
    m.loadLateInvoiceRequests.mockResolvedValue({ items: [], truncated: false });
    const html = await renderOn();
    expect(html).not.toContain("rechazadas en los últimos 30 días");
    expect(html).not.toContain("después de que se emitió a consumidor final");
  });

  it("paginación: página y total, y el siguiente conserva los filtros", async () => {
    const html = await renderOn({ state: "accepted", q: "ana" });
    expect(html).toContain("Página 1 de 2 · 73 facturas");
    expect(html).toContain('href="/operator/facturas?state=accepted&amp;q=ana&amp;page=2"');
    expect(html).not.toContain(">Anterior<");
  });

  it("el filtro de estado cambia de estado y vuelve a la página 1", async () => {
    m.loadInvoiceListPage.mockResolvedValue({ rows: ROWS, total: 73, page: 2, pageCount: 2 });
    const html = await renderOn({ q: "ana", page: "2" });
    expect(html).toContain('href="/operator/facturas?state=rejected&amp;q=ana"');
    expect(html).toContain('href="/operator/facturas?q=ana"');
  });
});
