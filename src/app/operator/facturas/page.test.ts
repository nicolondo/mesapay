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
