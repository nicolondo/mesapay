import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InvoiceSnapshot } from "@/lib/invoice";
import { parseInvoicePayload } from "@/lib/escpos";

/**
 * El encolado de la tirilla del cliente. Lo que hay que blindar:
 *
 *   1. sólo alcanza a las impresoras de FACTURA activas — una comanda
 *      saliendo por la caja, o la cuenta del cliente por la impresora de
 *      la parrilla, es un error que el comensal ve;
 *   2. un comercio sin impresora de facturas se comporta exactamente como
 *      antes (0 trabajos, sin efectos);
 *   3. la clave de idempotencia sale del id de la FACTURA, para que
 *      re-emitirla no la vuelva a imprimir; y
 *   4. no puede tumbar la emisión: si la DB falla, se traga y se loguea.
 *
 * La DB es un doble en memoria. El traductor NO se moquea a propósito:
 * así el test también verifica que las claves del catálogo existan de
 * verdad — una tirilla que imprime "emailInvoice.total" es papel perdido.
 */

const h = vi.hoisted(() => {
  const state = {
    printers: [] as Array<{
      id: string;
      restaurantId: string;
      kind: string;
      active: boolean;
      paperWidthMm: number | null;
    }>,
    created: [] as Array<Record<string, unknown>>,
    findManyWhere: null as unknown,
    throwOnCreate: false,
  };

  const db = {
    printer: {
      findMany: vi.fn(
        async (args: {
          where: { restaurantId: string; kind: string; active: boolean };
          select: unknown;
        }) => {
          state.findManyWhere = args.where;
          return state.printers
            .filter(
              (p) =>
                p.restaurantId === args.where.restaurantId &&
                p.kind === args.where.kind &&
                p.active === args.where.active,
            )
            .map((p) => ({ id: p.id, paperWidthMm: p.paperWidthMm }));
        },
      ),
    },
    restaurant: {
      findUnique: vi.fn(async () => ({
        printPaperWidthMm: 80,
        country: "CO",
      })),
    },
    payment: {
      findMany: vi.fn(async () => [
        { method: "demo_cash", amountCents: 6_100_000, tipCents: 600_000 },
      ]),
    },
    printJob: {
      createMany: vi.fn(
        async (args: { data: Array<Record<string, unknown>> }) => {
          if (state.throwOnCreate) throw new Error("db caída");
          state.created.push(...args.data);
          return { count: args.data.length };
        },
      ),
    },
  };

  return { state, db };
});

vi.mock("@/lib/db", () => ({ db: h.db }));
vi.mock("@/lib/billing/countries", () => ({
  getCurrencyForCountry: vi.fn(async () => "COP"),
}));

const snapshot: InvoiceSnapshot = {
  restaurantName: "Donde Chucho",
  logoUrl: null,
  legalName: "Inversiones Chucho S.A.S.",
  taxId: "900.123.456-7",
  legalAddress: "Calle 12 #4-56",
  legalCity: "Medellín",
  legalPhone: "604 444 5566",
  dianResolution: "18764012345678",
  dianResolutionFrom: 1,
  dianResolutionTo: 5000,
  dianResolutionDate: null,
  invoicePrefix: "FE",
  shortCode: "A4F2",
  tableLabel: "Mesa 7",
  paidAtIso: "2026-09-08T19:41:00.000Z",
  items: [{ qty: 2, name: "Ñoquis con champiñón", priceCents: 2_450_000 }],
  subtotalCents: 4_900_000,
  taxCents: 0,
  discountCents: 0,
  tipCents: 600_000,
  totalCents: 5_500_000,
  customer: null,
};

const args = {
  restaurantId: "rest-1",
  orderId: "order-1",
  invoiceId: "inv-1",
  invoiceNumber: 42,
  snapshot,
  locale: "es",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.state.printers = [];
  h.state.created = [];
  h.state.findManyWhere = null;
  h.state.throwOnCreate = false;
});

describe("enqueueInvoicePrint — a quién le llega", () => {
  it("sólo busca impresoras de factura ACTIVAS del comercio", async () => {
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    await enqueueInvoicePrint(args);
    expect(h.state.findManyWhere).toEqual({
      restaurantId: "rest-1",
      kind: "factura",
      active: true,
    });
  });

  it("la impresora de la cocina NO recibe la factura", async () => {
    h.state.printers = [
      {
        id: "p-cocina",
        restaurantId: "rest-1",
        kind: "comanda",
        active: true,
        paperWidthMm: 80,
      },
    ];
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint(args)).toBe(0);
    expect(h.state.created).toHaveLength(0);
  });

  it("una impresora de facturas APAGADA tampoco", async () => {
    h.state.printers = [
      {
        id: "p-caja",
        restaurantId: "rest-1",
        kind: "factura",
        active: false,
        paperWidthMm: null,
      },
    ];
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint(args)).toBe(0);
  });

  it("un comercio sin impresora de facturas no hace nada más", async () => {
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint(args)).toBe(0);
    // Ni siquiera va a buscar los pagos: el camino barato es el normal.
    expect(h.db.payment.findMany).not.toHaveBeenCalled();
    expect(h.db.printJob.createMany).not.toHaveBeenCalled();
  });

  it("dos impresoras de facturas reciben una copia cada una", async () => {
    h.state.printers = [
      {
        id: "p-caja1",
        restaurantId: "rest-1",
        kind: "factura",
        active: true,
        paperWidthMm: 80,
      },
      {
        id: "p-caja2",
        restaurantId: "rest-1",
        kind: "factura",
        active: true,
        paperWidthMm: 58,
      },
    ];
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint(args)).toBe(2);
    expect(h.state.created.map((r) => r.printerId)).toEqual([
      "p-caja1",
      "p-caja2",
    ]);
  });
});

describe("enqueueInvoicePrint — el trabajo que crea", () => {
  beforeEach(() => {
    h.state.printers = [
      {
        id: "p-caja",
        restaurantId: "rest-1",
        kind: "factura",
        active: true,
        paperWidthMm: null,
      },
    ];
  });

  it("es un customer_invoice, con la orden y la clave de la factura", async () => {
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    await enqueueInvoicePrint(args);
    expect(h.state.created[0]).toMatchObject({
      restaurantId: "rest-1",
      printerId: "p-caja",
      kind: "customer_invoice",
      orderId: "order-1",
      dedupeKey: "invoice:inv-1",
    });
  });

  it("hereda el ancho del comercio cuando la impresora no declara el suyo", async () => {
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    await enqueueInvoicePrint(args);
    const doc = parseInvoicePayload(h.state.created[0].payload)!;
    expect(doc.paperWidthMm).toBe(80);
  });

  it("se encola con skipDuplicates: re-emitir no reimprime", async () => {
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    await enqueueInvoicePrint(args);
    expect(h.db.printJob.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
  });

  it("el payload es una factura renderizable, con textos de verdad", async () => {
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    await enqueueInvoicePrint(args);
    const doc = parseInvoicePayload(h.state.created[0].payload)!;
    expect(doc).not.toBeNull();
    expect(doc.businessName).toBe("Inversiones Chucho S.A.S.");
    expect(doc.documentNumber).toBe("FE-0042");
    expect(doc.items[0].name).toBe("Ñoquis con champiñón");
    // Las claves del catálogo existen: si faltaran, next-intl devolvería
    // "emailInvoice.total" en vez del texto.
    for (const label of [
      doc.documentLabel,
      doc.paymentTitle ?? "",
      ...doc.totals.map((r) => r.label),
      ...doc.paymentRows.map((r) => r.label),
    ]) {
      expect(label).not.toContain("emailInvoice.");
    }
  });

  it("los montos salen en la moneda del comercio, no en centavos crudos", async () => {
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    await enqueueInvoicePrint(args);
    const doc = parseInvoicePayload(h.state.created[0].payload)!;
    const total = doc.totals.find((r) => r.strong)!;
    expect(total.amount).toContain("55.000");
  });

  it("la forma de pago sale de los pagos aprobados de la orden", async () => {
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    await enqueueInvoicePrint(args);
    expect(h.db.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: "order-1", status: "approved" },
      }),
    );
    const doc = parseInvoicePayload(h.state.created[0].payload)!;
    expect(doc.paymentRows).toHaveLength(1);
    // efectivo + propina = el total de la cuenta
    expect(doc.paymentRows[0].amount).toContain("67.000");
  });
});

describe("enqueueInvoicePrintSafe — no puede tumbar la emisión", () => {
  it("se traga el error de la cola: la factura ya está emitida", async () => {
    h.state.printers = [
      {
        id: "p-caja",
        restaurantId: "rest-1",
        kind: "factura",
        active: true,
        paperWidthMm: 80,
      },
    ];
    h.state.throwOnCreate = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { enqueueInvoicePrintSafe } = await import("./invoiceQueue");
    await expect(enqueueInvoicePrintSafe(args)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
