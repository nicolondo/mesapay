import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrebillData } from "@/lib/prebill";
import { parsePrebillPayload } from "@/lib/escpos";

/**
 * El encolado de la precuenta. Lo que hay que blindar:
 *
 *   1. sólo alcanza a las impresoras de FACTURA activas (la precuenta no
 *      sale por la de la parrilla);
 *   2. sin impresora, o con el agente muerto, NO encola y lo dice con un
 *      `reason` — es lo que dispara el respaldo del navegador;
 *   3. sin `dedupeKey`: reimprimir a propósito está permitido;
 *   4. un payload por impresora, con SU ancho de papel.
 *
 * La DB es un doble en memoria y la lectura de la cuenta se moquea (se
 * prueba aparte). El traductor NO se moquea a propósito: así el test
 * también verifica que las claves del catálogo existan de verdad — una
 * precuenta que imprime "emailInvoice.prebillTitle" es papel perdido.
 */

type PrinterRow = {
  id: string;
  kind: string;
  label: string;
  paperWidthMm: number | null;
  agent: { lastSeenAt: Date | null; revokedAt: Date | null; deletedAt: Date | null } | null;
};

const h = vi.hoisted(() => ({
  printers: vi.fn(async (): Promise<PrinterRow[]> => []),
  findManyWhere: null as unknown,
  createMany: vi.fn(async (args: { data: Array<Record<string, unknown>> }) => ({
    count: args.data.length,
  })),
  loadPrebill: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    printer: {
      findMany: vi.fn(async (args: { where: unknown }) => {
        h.findManyWhere = args.where;
        return h.printers();
      }),
    },
    printJob: { createMany: h.createMany },
  },
}));
vi.mock("./prebillData", () => ({ loadPrebill: h.loadPrebill }));

import { enqueuePrebillTicket } from "./prebillQueue";

const data: PrebillData = {
  businessName: "Inversiones Chucho S.A.S.",
  taxId: "900.123.456-7",
  legalAddress: "Calle 12 #4-56",
  legalCity: "Medellín",
  legalPhone: null,
  shortCode: "A4F2",
  destination: { kind: "table", number: 7, label: null },
  waiterName: "Carlos",
  issuedAt: new Date("2026-09-18T19:41:00.000Z"),
  lines: [
    {
      qty: 2,
      name: "Ñoquis con champiñón",
      unitCents: 2_450_000,
      lineCents: 4_900_000,
      modifiers: [],
      notes: null,
      guestName: null,
    },
  ],
  grossSubtotalCents: 4_900_000,
  discountPct: null,
  discountCents: 0,
  netSubtotalCents: 4_900_000,
  embeddedTax: { kind: "inc", pct: 8, taxCents: 362_963, baseCents: 4_537_037 },
  taxOnTop: { inc: 0, iva: 0 },
  taxOnTopCents: 0,
  totalCents: 4_900_000,
  paidCents: 0,
  outstandingCents: 4_900_000,
  suggestedTipPct: 10,
  suggestedTipCents: 490_000,
  totalWithTipCents: 5_390_000,
};

const args = { restaurantId: "rest-1", orderId: "order-1", requestedByUserId: "user-1" };

const online = { lastSeenAt: new Date(), revokedAt: null, deletedAt: null };
const cajaPrinter = (over: Partial<PrinterRow> = {}): PrinterRow => ({
  id: "printer-caja",
  kind: "factura",
  label: "Caja",
  paperWidthMm: 80,
  agent: online,
  ...over,
});

let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  h.findManyWhere = null;
  h.printers.mockResolvedValue([]);
  h.loadPrebill.mockResolvedValue({
    ok: true,
    data,
    locale: "es",
    currency: "COP",
    paperWidthMm: 80,
  });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  log.mockRestore();
});

describe("enqueuePrebillTicket — a quién le llega", () => {
  it("sólo busca impresoras de factura ACTIVAS del comercio", async () => {
    await enqueuePrebillTicket(args);
    expect(h.findManyWhere).toEqual({
      restaurantId: "rest-1",
      kind: "factura",
      active: true,
    });
  });

  it("sin impresora de facturas no encola, avisa y lo dice", async () => {
    expect(await enqueuePrebillTicket(args)).toEqual({ queued: false, reason: "no_printer" });
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.loadPrebill).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("una impresora de comanda que se colara por el where tampoco recibe la precuenta", async () => {
    h.printers.mockResolvedValue([cajaPrinter({ kind: "comanda", label: "Parrilla" })]);
    expect(await enqueuePrebillTicket(args)).toEqual({ queued: false, reason: "no_printer" });
  });

  it("con el agente muerto (o revocado) no encola: la precuenta saldría cuando la mesa ya se fue", async () => {
    const hace1h = new Date(Date.now() - 60 * 60 * 1000);
    h.printers.mockResolvedValue([
      cajaPrinter({ agent: { ...online, lastSeenAt: hace1h } }),
      cajaPrinter({ id: "printer-2", agent: { ...online, revokedAt: new Date() } }),
      cajaPrinter({ id: "printer-3", agent: { ...online, lastSeenAt: null } }),
    ]);
    expect(await enqueuePrebillTicket(args)).toEqual({ queued: false, reason: "agent_offline" });
    expect(h.createMany).not.toHaveBeenCalled();
  });

  it("un agente 'tarde' (perdió un par de latidos) todavía recibe el trabajo", async () => {
    const hace3min = new Date(Date.now() - 3 * 60 * 1000);
    h.printers.mockResolvedValue([cajaPrinter({ agent: { ...online, lastSeenAt: hace3min } })]);
    expect((await enqueuePrebillTicket(args)).queued).toBe(true);
  });

  it("una impresora sin agente (creada en soporte) se deja pasar", async () => {
    h.printers.mockResolvedValue([cajaPrinter({ agent: null })]);
    expect((await enqueuePrebillTicket(args)).queued).toBe(true);
  });
});

describe("enqueuePrebillTicket — el trabajo", () => {
  beforeEach(() => {
    h.printers.mockResolvedValue([cajaPrinter()]);
  });

  it("encola un PrintJob de tipo prebill, sin dedupeKey, y nombra la impresora", async () => {
    const r = await enqueuePrebillTicket(args);
    expect(r).toEqual({ queued: true, printerName: "Caja", jobs: 1 });
    expect(h.createMany).toHaveBeenCalledOnce();
    const row = h.createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({
      restaurantId: "rest-1",
      printerId: "printer-caja",
      kind: "prebill",
      orderId: "order-1",
      dedupeKey: null,
    });
  });

  it("el payload es una precuenta válida, traducida con el catálogo real", async () => {
    await enqueuePrebillTicket(args);
    const row = h.createMany.mock.calls[0][0].data[0];
    const doc = parsePrebillPayload(row.payload);
    expect(doc).not.toBeNull();
    expect(doc!.title).toBe("PRECUENTA");
    expect(doc!.notInvoiceLine).toBe("Este documento no es una factura");
    expect(doc!.businessName).toBe("Inversiones Chucho S.A.S.");
    expect(doc!.metaRows).toContainEqual({ label: "Mesa 7", value: "A4F2" });
    expect(doc!.metaRows).toContainEqual({ label: "Mesero", value: "Carlos" });
    expect(doc!.items[0]).toMatchObject({ qty: 2, name: "Ñoquis con champiñón" });
    expect(doc!.totals.map((r) => r.label)).toEqual([
      "Subtotal",
      "Base gravable",
      "Incl. impoconsumo 8%",
      "TOTAL",
    ]);
    expect(doc!.tipRows.map((r) => r.label)).toEqual(["Propina sugerida 10%", "Total con propina"]);
    expect(doc!.tipNotice).toContain("voluntaria");
    // Ninguna clave sin traducir.
    for (const s of JSON.stringify(doc).split('"')) expect(s).not.toMatch(/^prebill[A-Z]/);
  });

  it("los montos van en la moneda del comercio y el idioma de la orden", async () => {
    h.loadPrebill.mockResolvedValue({ ok: true, data, locale: "en", currency: "COP", paperWidthMm: 80 });
    await enqueuePrebillTicket(args);
    const doc = parsePrebillPayload(h.createMany.mock.calls[0][0].data[0].payload)!;
    expect(doc.title).toBe("PRE-BILL");
    expect(doc.totals[doc.totals.length - 1]).toMatchObject({ label: "TOTAL", amount: "$49,000" });
  });

  it("una impresora de 58mm y otra de 80mm reciben documentos con su ancho", async () => {
    h.printers.mockResolvedValue([
      cajaPrinter({ id: "p80", label: "Caja", paperWidthMm: 80 }),
      cajaPrinter({ id: "p58", label: "Barra", paperWidthMm: 58 }),
      cajaPrinter({ id: "pdef", label: "Mostrador", paperWidthMm: null }),
    ]);
    const r = await enqueuePrebillTicket(args);
    expect(r).toEqual({ queued: true, printerName: "Caja · Barra · Mostrador", jobs: 3 });
    const widths = h.createMany.mock.calls[0][0].data.map(
      (row) => parsePrebillPayload(row.payload)!.paperWidthMm,
    );
    // La sin ancho propio hereda el del comercio (80).
    expect(widths).toEqual([80, 58, 80]);
  });

  it("si la cuenta no se puede leer, devuelve ese motivo tal cual", async () => {
    h.loadPrebill.mockResolvedValue({ ok: false, reason: "order_closed" });
    expect(await enqueuePrebillTicket(args)).toEqual({ queued: false, reason: "order_closed" });
    expect(h.createMany).not.toHaveBeenCalled();
  });
});
