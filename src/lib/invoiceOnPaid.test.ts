import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El helper habla con la DB, con el emisor de tirillas y con la emisión a
 * la DIAN, así que todo eso va mockeado. Lo que se prueba es la DECISIÓN:
 * con facturación electrónica TODA venta se factura (nominativa o
 * genérica) y nace su DianDocument; sin ella, sólo lo que pidieron —
 * exactamente como antes. Y la idempotencia, que es lo que impide que una
 * orden pagada por dos rieles (webhook + settle manual) mande dos facturas.
 */

const m = vi.hoisted(() => ({
  orderFindUnique: vi.fn(),
  requestFindFirst: vi.fn(),
  issueSimpleInvoice: vi.fn(),
  sendSimpleInvoiceEmail: vi.fn(async () => undefined),
  resolveEmisor: vi.fn(),
  ensureDianDocument: vi.fn(),
  recordNumberingExhausted: vi.fn(async () => undefined),
  emitDianInvoice: vi.fn(),
  after: vi.fn(),
}));

vi.mock("next/server", () => ({ after: m.after }));
vi.mock("@/lib/db", () => ({
  db: {
    order: { findUnique: m.orderFindUnique },
    invoiceRequest: { findFirst: m.requestFindFirst },
  },
}));
vi.mock("@/lib/simpleInvoice", () => ({
  issueSimpleInvoice: m.issueSimpleInvoice,
  sendSimpleInvoiceEmail: m.sendSimpleInvoiceEmail,
}));
vi.mock("@/lib/dian/config", () => ({ resolveEmisor: m.resolveEmisor }));
vi.mock("@/lib/dian/emit", () => ({
  ensureDianDocument: m.ensureDianDocument,
  recordNumberingExhausted: m.recordNumberingExhausted,
}));
vi.mock("@/lib/dian/emitInvoice", () => ({ emitDianInvoice: m.emitDianInvoice }));
vi.mock("@/lib/modules", () => ({
  isModuleEnabled: (mods: unknown, slug: string) =>
    Array.isArray(mods) && mods.includes(slug),
}));

import { isBillableOrder, issueInvoiceOnPaid, numberingExhausted } from "./invoiceOnPaid";

type OrderRow = {
  id: string;
  restaurantId: string;
  status: string;
  simpleInvoiceEmail: string | null;
  subtotalCents: number;
  compedAt: Date | null;
  simpleInvoice: { id: string } | null;
  restaurant: { enabledModules: string[] };
};

function order(over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "order-1",
    restaurantId: "rest-1",
    status: "paid",
    simpleInvoiceEmail: null,
    subtotalCents: 50_000_00,
    compedAt: null,
    simpleInvoice: null,
    restaurant: { enabledModules: ["einvoicing"] },
    ...over,
  };
}

const REQUEST = {
  id: "req-1",
  email: "ana@correo.com",
  customerName: "Ana Pérez",
  docType: "CC",
  docNumber: "1020304050",
  address: "Calle 1 #2-3",
  city: "Bogotá",
  department: "Cundinamarca",
};

const CUSTOMER = {
  name: "Ana Pérez",
  docType: "CC",
  docNumber: "1020304050",
  address: "Calle 1 #2-3",
  city: "Bogotá",
  department: "Cundinamarca",
};

function issuedOk(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    invoiceId: "inv-1",
    invoiceUrl: "https://mesapay.co/factura/inv-1",
    invoiceNumber: 7,
    snapshot: { restaurantName: "Test" },
    email: null,
    locale: "es",
    alreadyIssued: false,
    ...over,
  };
}

const call = (emit: "after" | "inline" | "none" = "inline") =>
  issueInvoiceOnPaid({ tenantId: "rest-1", orderId: "order-1", emit });

beforeEach(() => {
  vi.resetAllMocks();
  m.orderFindUnique.mockResolvedValue(order());
  m.requestFindFirst.mockResolvedValue(null);
  m.issueSimpleInvoice.mockResolvedValue(issuedOk());
  m.resolveEmisor.mockResolvedValue({ resolutionTo: 10000, invoiceNextNumber: 6485 });
  m.ensureDianDocument.mockResolvedValue({
    id: "doc-1",
    state: "to_send",
    attempts: 0,
    created: true,
  });
  m.emitDianInvoice.mockResolvedValue({ outcome: "accepted", documentId: "doc-1" });
  // `after` corre la tarea ya mismo: lo que importa es que se programe.
  m.after.mockImplementation((task: () => Promise<void>) => {
    void task();
  });
});

describe("guards comunes", () => {
  it("no hace nada si la orden todavía no está pagada", async () => {
    m.orderFindUnique.mockResolvedValue(order({ status: "paying" }));
    m.requestFindFirst.mockResolvedValue(REQUEST);
    expect(await call()).toEqual({ status: "skipped", reason: "not_paid" });
    expect(m.issueSimpleInvoice).not.toHaveBeenCalled();
    expect(m.ensureDianDocument).not.toHaveBeenCalled();
  });

  it("no toca órdenes de otro comercio", async () => {
    expect(
      await issueInvoiceOnPaid({ tenantId: "otro-rest", orderId: "order-1", emit: "inline" }),
    ).toEqual({ status: "skipped", reason: "not_found" });
    expect(m.issueSimpleInvoice).not.toHaveBeenCalled();
  });

  // Un fallo acá no puede tumbar el cobro que lo llamó.
  it("nunca lanza aunque la emisión reviente", async () => {
    m.issueSimpleInvoice.mockRejectedValue(new Error("boom"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(call()).resolves.toEqual({ status: "failed" });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("SIN facturación electrónica — exactamente como antes", () => {
  const off = { enabledModules: [] as string[] };

  it("no emite si nadie pidió factura", async () => {
    m.orderFindUnique.mockResolvedValue(order({ restaurant: off }));
    expect(await call()).toEqual({ status: "skipped", reason: "not_requested" });
    expect(m.issueSimpleInvoice).not.toHaveBeenCalled();
    expect(m.ensureDianDocument).not.toHaveBeenCalled();
  });

  it("emite la personalizada y manda el correo cuando hay solicitud", async () => {
    m.orderFindUnique.mockResolvedValue(order({ restaurant: off }));
    m.requestFindFirst.mockResolvedValue(REQUEST);
    m.issueSimpleInvoice.mockResolvedValue(issuedOk({ email: "ana@correo.com" }));
    const r = await call();
    expect(r).toEqual({ status: "issued", invoiceId: "inv-1", alreadyIssued: false, emit: null });
    expect(m.issueSimpleInvoice).toHaveBeenCalledWith({
      tenantId: "rest-1",
      orderId: "order-1",
      email: "ana@correo.com",
      customer: CUSTOMER,
    });
    expect(m.sendSimpleInvoiceEmail).toHaveBeenCalledTimes(1);
    // A la DIAN no va nada.
    expect(m.ensureDianDocument).not.toHaveBeenCalled();
    expect(m.emitDianInvoice).not.toHaveBeenCalled();
  });

  it("emite la genérica cuando sólo quedó el correo del checkout", async () => {
    m.orderFindUnique.mockResolvedValue(
      order({ restaurant: off, simpleInvoiceEmail: "ana@correo.com" }),
    );
    await call();
    expect(m.issueSimpleInvoice).toHaveBeenCalledWith({
      tenantId: "rest-1",
      orderId: "order-1",
      email: "ana@correo.com",
      customer: null,
    });
    expect(m.ensureDianDocument).not.toHaveBeenCalled();
  });
});

describe("CON facturación electrónica — toda venta se factura", () => {
  it("sin solicitud: tirilla genérica sin correo + DianDocument + intento inmediato", async () => {
    const r = await call();
    expect(m.issueSimpleInvoice).toHaveBeenCalledWith({
      tenantId: "rest-1",
      orderId: "order-1",
      email: null,
      customer: null,
    });
    // Nadie dejó correo: la tirilla existe, no se manda a ningún lado.
    expect(m.sendSimpleInvoiceEmail).not.toHaveBeenCalled();
    expect(m.ensureDianDocument).toHaveBeenCalledWith({
      simpleInvoiceId: "inv-1",
      restaurantId: "rest-1",
      orderId: "order-1",
    });
    expect(m.emitDianInvoice).toHaveBeenCalledWith({
      simpleInvoiceId: "inv-1",
      restaurantId: "rest-1",
    });
    expect(r).toEqual({
      status: "issued",
      invoiceId: "inv-1",
      alreadyIssued: false,
      emit: { outcome: "accepted", documentId: "doc-1" },
    });
  });

  it("con solicitud: tirilla nominativa + DianDocument, y NUNCA el comprobante por correo", async () => {
    m.requestFindFirst.mockResolvedValue(REQUEST);
    m.issueSimpleInvoice.mockResolvedValue(issuedOk({ email: "ana@correo.com" }));
    await call();
    expect(m.issueSimpleInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ email: "ana@correo.com", customer: CUSTOMER }),
    );
    // Con facturación electrónica el comensal recibe la FACTURA ELECTRÓNICA
    // (la manda la aceptación de la DIAN), no el comprobante de MESAPAY.
    // Regla en invoiceDelivery.ts, pedida textual por el dueño.
    expect(m.sendSimpleInvoiceEmail).not.toHaveBeenCalled();
    expect(m.ensureDianDocument).toHaveBeenCalledTimes(1);
    expect(m.emitDianInvoice).toHaveBeenCalledTimes(1);
  });

  it("emit: 'after' programa el intento después de la respuesta; 'none' no intenta", async () => {
    const r = await call("after");
    expect(m.after).toHaveBeenCalledTimes(1);
    expect(m.emitDianInvoice).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "issued", emit: null });

    vi.clearAllMocks();
    m.orderFindUnique.mockResolvedValue(order());
    m.issueSimpleInvoice.mockResolvedValue(issuedOk());
    m.resolveEmisor.mockResolvedValue({ resolutionTo: 10000, invoiceNextNumber: 6485 });
    m.ensureDianDocument.mockResolvedValue({ id: "doc-1", state: "to_send", attempts: 0, created: true });
    await call("none");
    expect(m.ensureDianDocument).toHaveBeenCalledTimes(1);
    expect(m.emitDianInvoice).not.toHaveBeenCalled();
  });

  it("'after' fuera de un request cae a dispararlo al aire", async () => {
    m.after.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope");
    });
    await call("after");
    // El fallback lo dispara igual (void task()); el mock resuelve ya.
    await new Promise((r) => setTimeout(r, 0));
    expect(m.emitDianInvoice).toHaveBeenCalledTimes(1);
  });

  it("el intento inmediato que revienta se traga: el barrido lo retoma", async () => {
    m.emitDianInvoice.mockRejectedValue(new Error("DIAN caída"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call();
    expect(r).toMatchObject({ status: "issued", emit: null });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("idempotencia — dos rieles, una factura", () => {
  it("con la tirilla ya emitida no re-numera ni re-manda el correo, pero sí asegura el DianDocument", async () => {
    m.orderFindUnique.mockResolvedValue(order({ simpleInvoice: { id: "inv-1" } }));
    m.issueSimpleInvoice.mockResolvedValue(issuedOk({ email: "ana@correo.com", alreadyIssued: true }));
    const r = await call();
    expect(m.sendSimpleInvoiceEmail).not.toHaveBeenCalled();
    // La tirilla pudo nacer antes de la emisión automática (o el proceso
    // murió entre la tirilla y el documento): el documento se crea igual.
    expect(m.ensureDianDocument).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "issued", alreadyIssued: true });
  });

  it("con el DianDocument ya existente (aceptado, en error, en vuelo) NO se re-emite desde acá", async () => {
    for (const state of ["accepted", "error", "sent", "pending", "rejected"]) {
      vi.clearAllMocks();
      m.orderFindUnique.mockResolvedValue(order());
      m.issueSimpleInvoice.mockResolvedValue(issuedOk({ alreadyIssued: true }));
      m.resolveEmisor.mockResolvedValue({ resolutionTo: 10000, invoiceNextNumber: 6485 });
      m.ensureDianDocument.mockResolvedValue({ id: "doc-1", state, attempts: 1, created: false });
      const r = await call();
      expect(m.emitDianInvoice).not.toHaveBeenCalled();
      expect(r).toMatchObject({ status: "issued", emit: null });
    }
  });

  it("un placeholder adoptado (to_send) sí se intenta", async () => {
    m.ensureDianDocument.mockResolvedValue({ id: "doc-1", state: "to_send", attempts: 0, created: true });
    await call();
    expect(m.emitDianInvoice).toHaveBeenCalledTimes(1);
  });
});

describe("lo que NO es una venta facturable", () => {
  it("una cortesía ($0, comp) no se factura sola ni va a la DIAN", async () => {
    m.orderFindUnique.mockResolvedValue(order({ compedAt: new Date(), subtotalCents: 0 }));
    expect(await call()).toEqual({ status: "skipped", reason: "not_billable" });
    expect(m.issueSimpleInvoice).not.toHaveBeenCalled();
    expect(m.ensureDianDocument).not.toHaveBeenCalled();
  });

  it("una cortesía con solicitud saca el comprobante, como antes, pero no a la DIAN", async () => {
    m.orderFindUnique.mockResolvedValue(order({ compedAt: new Date(), subtotalCents: 0 }));
    m.requestFindFirst.mockResolvedValue(REQUEST);
    const r = await call();
    expect(m.issueSimpleInvoice).toHaveBeenCalledTimes(1);
    expect(m.ensureDianDocument).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: "issued", emit: null });
  });

  it("una cuenta en $0 sin cortesía tampoco", async () => {
    m.orderFindUnique.mockResolvedValue(order({ subtotalCents: 0 }));
    expect(await call()).toEqual({ status: "skipped", reason: "not_billable" });
  });

  it("isBillableOrder", () => {
    expect(isBillableOrder({ compedAt: null, subtotalCents: 1 })).toBe(true);
    expect(isBillableOrder({ compedAt: new Date(), subtotalCents: 1 })).toBe(false);
    expect(isBillableOrder({ compedAt: null, subtotalCents: 0 })).toBe(false);
  });
});

describe("tope de rango — sin número válido no hay factura", () => {
  it("con el rango agotado no numera la tirilla ni emite: deja constancia colgada de la orden", async () => {
    m.resolveEmisor.mockResolvedValue({ resolutionTo: 10000, invoiceNextNumber: 10001 });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await call();
    expect(r).toEqual({ status: "blocked", reason: "numbering_exhausted" });
    expect(m.issueSimpleInvoice).not.toHaveBeenCalled();
    expect(m.ensureDianDocument).not.toHaveBeenCalled();
    expect(m.emitDianInvoice).not.toHaveBeenCalled();
    expect(m.recordNumberingExhausted).toHaveBeenCalledWith({
      restaurantId: "rest-1",
      orderId: "order-1",
    });
    warned.mockRestore();
  });

  it("el último número del rango todavía sirve", async () => {
    m.resolveEmisor.mockResolvedValue({ resolutionTo: 10000, invoiceNextNumber: 10000 });
    await call();
    expect(m.issueSimpleInvoice).toHaveBeenCalledTimes(1);
    expect(m.recordNumberingExhausted).not.toHaveBeenCalled();
  });

  it("sin tope cargado no se frena (lo frena el emit, sin quemar nada)", async () => {
    m.resolveEmisor.mockResolvedValue({ resolutionTo: null, invoiceNextNumber: 99999 });
    await call();
    expect(m.issueSimpleInvoice).toHaveBeenCalledTimes(1);
  });

  it("con la tirilla ya numerada no se vuelve a mirar el rango", async () => {
    m.orderFindUnique.mockResolvedValue(order({ simpleInvoice: { id: "inv-1" } }));
    m.resolveEmisor.mockResolvedValue({ resolutionTo: 10000, invoiceNextNumber: 10001 });
    m.issueSimpleInvoice.mockResolvedValue(issuedOk({ alreadyIssued: true }));
    await call();
    expect(m.resolveEmisor).not.toHaveBeenCalled();
    expect(m.ensureDianDocument).toHaveBeenCalledTimes(1);
  });

  it("sin facturación electrónica el rango no aplica (como antes)", async () => {
    m.orderFindUnique.mockResolvedValue(
      order({ restaurant: { enabledModules: [] }, simpleInvoiceEmail: "a@b.co" }),
    );
    m.resolveEmisor.mockResolvedValue({ resolutionTo: 10, invoiceNextNumber: 99 });
    await call();
    expect(m.issueSimpleInvoice).toHaveBeenCalledTimes(1);
    expect(m.recordNumberingExhausted).not.toHaveBeenCalled();
  });

  it("numberingExhausted", () => {
    expect(numberingExhausted(null)).toBe(false);
    expect(numberingExhausted({ resolutionTo: null, invoiceNextNumber: 5 })).toBe(false);
    expect(numberingExhausted({ resolutionTo: 10, invoiceNextNumber: 10 })).toBe(false);
    expect(numberingExhausted({ resolutionTo: 10, invoiceNextNumber: 11 })).toBe(true);
  });
});
