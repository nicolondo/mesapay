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
  const defaultRestaurant = () => ({
    printPaperWidthMm: 80,
    country: "CO",
    invoicePrinterId: null as string | null,
    invoiceAutoPrint: true,
    enabledModules: [] as string[],
  });
  const state = {
    printers: [] as Array<{
      id: string;
      restaurantId: string;
      kind: string;
      active: boolean;
      paperWidthMm: number | null;
      supportsQr?: boolean;
    }>,
    restaurant: defaultRestaurant(),
    /** La fila de la tirilla que lee `printAcceptedDianInvoice`. */
    invoiceRow: null as Record<string, unknown> | null,
    created: [] as Array<Record<string, unknown>>,
    findManyWhere: null as unknown,
    throwOnCreate: false,
  };

  const db = {
    printer: {
      findMany: vi.fn(
        async (args: {
          where: { restaurantId: string; kind?: string; id?: string; active: boolean };
          select: unknown;
        }) => {
          state.findManyWhere = args.where;
          return state.printers
            .filter(
              (p) =>
                p.restaurantId === args.where.restaurantId &&
                p.active === args.where.active &&
                (args.where.id ? p.id === args.where.id : p.kind === args.where.kind),
            )
            .map((p) => ({
              id: p.id,
              paperWidthMm: p.paperWidthMm,
              supportsQr: p.supportsQr ?? false,
            }));
        },
      ),
    },
    restaurant: {
      findUnique: vi.fn(async () => state.restaurant),
    },
    simpleInvoice: {
      findUnique: vi.fn(async () => state.invoiceRow),
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

  return { state, db, defaultRestaurant };
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
  h.state.restaurant = h.defaultRestaurant();
  h.state.invoiceRow = null;
  h.state.created = [];
  h.state.findManyWhere = null;
  h.state.throwOnCreate = false;
});

const caja = (over: Partial<(typeof h.state.printers)[number]> = {}) => ({
  id: "p-caja",
  restaurantId: "rest-1",
  kind: "factura",
  active: true,
  paperWidthMm: 80,
  ...over,
});
const cocina = (over: Partial<(typeof h.state.printers)[number]> = {}) => ({
  id: "p-cocina",
  restaurantId: "rest-1",
  kind: "comanda",
  active: true,
  paperWidthMm: 80,
  ...over,
});

const CUFE = "0123456789abcdef".repeat(6);
const dian = {
  cufe: CUFE,
  qrUrl: `https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${CUFE}`,
};

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

  it("una REIMPRESIÓN pedida a propósito va sin dedupeKey: la copia sí sale", async () => {
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint({ ...args, reprint: true })).toBe(1);
    // Mismo trabajo (kind, orden, payload renderizable) pero sin la clave:
    // en Postgres varios NULL no chocan contra el unique, así que la
    // segunda copia no se descarta como duplicado.
    expect(h.state.created[0]).toMatchObject({
      kind: "customer_invoice",
      orderId: "order-1",
      dedupeKey: null,
    });
    const doc = parseInvoicePayload(h.state.created[0].payload)!;
    expect(doc.documentNumber).toBe("FE42");
  });

  it("el payload es una factura renderizable, con textos de verdad", async () => {
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    await enqueueInvoicePrint(args);
    const doc = parseInvoicePayload(h.state.created[0].payload)!;
    expect(doc).not.toBeNull();
    expect(doc.businessName).toBe("Inversiones Chucho S.A.S.");
    expect(doc.documentNumber).toBe("FE42");
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

describe("invoicePrintArgs — el cobro y la reimpresión mandan lo mismo", () => {
  it("arma los argumentos desde la fila de la factura y el idioma de la ORDEN", async () => {
    const { invoicePrintArgs } = await import("./routing");
    expect(
      invoicePrintArgs(
        {
          id: "inv-1",
          restaurantId: "rest-1",
          orderId: "order-1",
          invoiceNumber: 42,
          snapshot: snapshot as unknown,
        },
        { locale: "pt" },
      ),
    ).toEqual({
      restaurantId: "rest-1",
      orderId: "order-1",
      invoiceId: "inv-1",
      invoiceNumber: 42,
      snapshot,
      locale: "pt",
    });
  });

  it("lo que arma es exactamente lo que acepta enqueueInvoicePrint", async () => {
    h.state.printers = [
      {
        id: "p-caja",
        restaurantId: "rest-1",
        kind: "factura",
        active: true,
        paperWidthMm: 80,
      },
    ];
    const { invoicePrintArgs } = await import("./routing");
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    const built = invoicePrintArgs(
      { id: "inv-1", restaurantId: "rest-1", orderId: "order-1", invoiceNumber: 42, snapshot },
      { locale: null },
    );
    expect(await enqueueInvoicePrint(built)).toBe(1);
    expect(h.state.created[0]).toMatchObject({ dedupeKey: "invoice:inv-1" });
  });
});

describe("enqueueInvoicePrint — la impresora elegida (Restaurant.invoicePrinterId)", () => {
  beforeEach(() => {
    h.state.printers = [caja(), cocina()];
  });

  it("sin elección: todas las de tipo factura, como siempre", async () => {
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint(args)).toBe(1);
    expect(h.state.created.map((r) => r.printerId)).toEqual(["p-caja"]);
  });

  it("con elección va SÓLO a esa impresora, aunque sea de comanda", async () => {
    h.state.restaurant.invoicePrinterId = "p-cocina";
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint(args)).toBe(1);
    expect(h.state.findManyWhere).toEqual({
      restaurantId: "rest-1",
      active: true,
      id: "p-cocina",
    });
    expect(h.state.created.map((r) => r.printerId)).toEqual(["p-cocina"]);
  });

  it("la elegida apagada ⇒ no sale papel (no se cae a las demás)", async () => {
    h.state.printers = [caja(), cocina({ active: false })];
    h.state.restaurant.invoicePrinterId = "p-cocina";
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint(args)).toBe(0);
    expect(h.state.created).toHaveLength(0);
  });

  it("la elegida de OTRO comercio no cuenta: el where sigue acotado al comercio", async () => {
    h.state.printers = [caja(), { ...cocina(), id: "p-ajena", restaurantId: "rest-2" }];
    h.state.restaurant.invoicePrinterId = "p-ajena";
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint(args)).toBe(0);
  });
});

describe("enqueueInvoicePrint — qué se imprime y cuándo", () => {
  beforeEach(() => {
    h.state.printers = [caja()];
  });

  it("sin facturación electrónica, el cobro (trigger paid) imprime el COMPROBANTE", async () => {
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint({ ...args, trigger: "paid" })).toBe(1);
    const doc = parseInvoicePayload(h.state.created[0].payload)!;
    expect(doc.documentLabel).toBe("Comprobante");
    expect(doc.fiscal).toBeNull();
    expect(doc.customerLines).toEqual([]);
  });

  it("con facturación electrónica, el cobro NO imprime: ni siquiera busca impresoras", async () => {
    h.state.restaurant.enabledModules = ["einvoicing"];
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint({ ...args, trigger: "paid" })).toBe(0);
    expect(h.db.printer.findMany).not.toHaveBeenCalled();
    expect(h.db.printJob.createMany).not.toHaveBeenCalled();
  });

  it("con facturación electrónica, la aceptación de la DIAN imprime la FACTURA ELECTRÓNICA con su CUFE", async () => {
    h.state.restaurant.enabledModules = ["einvoicing"];
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(
      await enqueueInvoicePrint({ ...args, trigger: "dian_accepted", dian }),
    ).toBe(1);
    expect(h.state.created[0]).toMatchObject({
      kind: "customer_invoice",
      dedupeKey: "invoice:inv-1",
    });
    const doc = parseInvoicePayload(h.state.created[0].payload)!;
    expect(doc.documentLabel).toBe("FACTURA ELECTRÓNICA DE VENTA");
    expect(doc.customerLines).toEqual(["Cliente: Consumidor final"]);
    expect(doc.fiscal).toMatchObject({
      cufeLabel: "CUFE",
      cufe: CUFE,
      verifyUrl: dian.qrUrl,
      qr: false,
      noticeLines: ["Representación impresa de la factura electrónica de venta"],
    });
  });

  it("el QR sale SÓLO en la impresora que lo soporta; en la otra, la URL en texto", async () => {
    h.state.printers = [
      caja({ id: "p-caja-qr", supportsQr: true }),
      caja({ id: "p-caja-sin", supportsQr: false }),
    ];
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(
      await enqueueInvoicePrint({ ...args, trigger: "dian_accepted", dian }),
    ).toBe(2);
    const byPrinter = Object.fromEntries(
      h.state.created.map((r) => [
        r.printerId,
        parseInvoicePayload(r.payload)!.fiscal!.qr,
      ]),
    );
    expect(byPrinter).toEqual({ "p-caja-qr": true, "p-caja-sin": false });
  });

  it("el comprobante nunca lleva QR, aunque la impresora lo soporte", async () => {
    h.state.printers = [caja({ supportsQr: true })];
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    await enqueueInvoicePrint({ ...args, trigger: "paid" });
    expect(parseInvoicePayload(h.state.created[0].payload)!.fiscal).toBeNull();
  });

  it("con invoiceAutoPrint apagado no imprime ni al cobrar ni al aceptar", async () => {
    h.state.restaurant.invoiceAutoPrint = false;
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint({ ...args, trigger: "paid" })).toBe(0);
    expect(
      await enqueueInvoicePrint({ ...args, trigger: "dian_accepted", dian }),
    ).toBe(0);
    expect(h.db.printer.findMany).not.toHaveBeenCalled();
  });

  it("con invoiceAutoPrint apagado la reimpresión manual sigue saliendo (y sin clave)", async () => {
    h.state.restaurant.invoiceAutoPrint = false;
    h.state.restaurant.enabledModules = ["einvoicing"];
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint({ ...args, reprint: true, dian })).toBe(1);
    expect(h.state.created[0]).toMatchObject({ dedupeKey: null });
    expect(parseInvoicePayload(h.state.created[0].payload)!.fiscal?.cufe).toBe(CUFE);
  });

  it("sin trigger explícito se asume el cobro (compatibilidad con los llamadores viejos)", async () => {
    h.state.restaurant.enabledModules = ["einvoicing"];
    const { enqueueInvoicePrint } = await import("./invoiceQueue");
    expect(await enqueueInvoicePrint(args)).toBe(0);
  });

  it.each(["es", "en", "pt"])(
    "las etiquetas de la factura electrónica existen en el catálogo %s",
    async (locale) => {
      const { enqueueInvoicePrint } = await import("./invoiceQueue");
      await enqueueInvoicePrint({ ...args, locale, trigger: "dian_accepted", dian });
      const doc = parseInvoicePayload(h.state.created[0].payload)!;
      for (const label of [
        doc.documentLabel,
        ...doc.customerLines,
        doc.fiscal!.cufeLabel,
        doc.fiscal!.verifyLabel,
        ...doc.fiscal!.noticeLines,
      ]) {
        expect(label).not.toContain("emailInvoice.");
        expect(label.trim().length).toBeGreaterThan(0);
      }
    },
  );
});

describe("printAcceptedDianInvoice — el hook de la aceptación de la DIAN", () => {
  const row = {
    id: "inv-1",
    restaurantId: "rest-1",
    orderId: "order-1",
    invoiceNumber: 42,
    snapshot,
    order: { locale: "es" },
  };

  beforeEach(() => {
    h.state.printers = [caja({ supportsQr: true })];
    h.state.restaurant.enabledModules = ["einvoicing"];
    h.state.invoiceRow = row;
  });

  it("encola la factura electrónica con la clave de la factura: la segunda aceptación choca", async () => {
    const { printAcceptedDianInvoice } = await import("./invoiceQueue");
    await printAcceptedDianInvoice({
      simpleInvoiceId: "inv-1",
      restaurantId: "rest-1",
      cufe: CUFE,
      qrUrl: dian.qrUrl,
    });
    expect(h.db.simpleInvoice.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "inv-1" } }),
    );
    expect(h.state.created).toHaveLength(1);
    expect(h.state.created[0]).toMatchObject({
      printerId: "p-caja",
      kind: "customer_invoice",
      orderId: "order-1",
      dedupeKey: "invoice:inv-1",
    });
    expect(h.db.printJob.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    const doc = parseInvoicePayload(h.state.created[0].payload)!;
    expect(doc.fiscal).toMatchObject({ cufe: CUFE, verifyUrl: dian.qrUrl, qr: true });
    expect(doc.documentNumber).toBe("FE42");
  });

  it("una tirilla de otro comercio no se imprime", async () => {
    h.state.invoiceRow = { ...row, restaurantId: "rest-2" };
    const { printAcceptedDianInvoice } = await import("./invoiceQueue");
    await printAcceptedDianInvoice({
      simpleInvoiceId: "inv-1",
      restaurantId: "rest-1",
      cufe: CUFE,
      qrUrl: dian.qrUrl,
    });
    expect(h.state.created).toHaveLength(0);
  });

  it("sin tirilla (documento del set de pruebas) no hace nada", async () => {
    h.state.invoiceRow = null;
    const { printAcceptedDianInvoice } = await import("./invoiceQueue");
    await printAcceptedDianInvoice({
      simpleInvoiceId: "inv-x",
      restaurantId: "rest-1",
      cufe: CUFE,
      qrUrl: dian.qrUrl,
    });
    expect(h.db.printJob.createMany).not.toHaveBeenCalled();
  });

  it("nunca lanza: la factura ya está aceptada y el correo ya salió", async () => {
    h.state.throwOnCreate = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { printAcceptedDianInvoice } = await import("./invoiceQueue");
    await expect(
      printAcceptedDianInvoice({
        simpleInvoiceId: "inv-1",
        restaurantId: "rest-1",
        cufe: CUFE,
        qrUrl: dian.qrUrl,
      }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
