// Cierre automático de solicitudes de factura al aceptarse la factura: el
// updateMany que corre en los dos rieles de la aceptación. Se simula la
// tabla en memoria con el MISMO filtro que recibe Prisma, para ver qué
// solicitudes quedan cerradas y cuáles (las que llegaron tarde) no.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ updateMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { invoiceRequest: { updateMany: m.updateMany } } }));

import {
  closeInvoiceRequestsAfterDeferredAcceptance,
  closeInvoiceRequestsOnAcceptance,
} from "./invoiceRequestClosure";
import { zipInvoice } from "./soap";

type Row = { id: string; orderId: string; status: string; createdAt: Date };
let table: Row[] = [];

/** updateMany de mentira que aplica el `where` de Prisma sobre `table`. */
function fakeUpdateMany(args: {
  where: { orderId: string; status: string; createdAt: { lte: Date } };
  data: { status: string };
}) {
  let count = 0;
  for (const r of table) {
    if (
      r.orderId === args.where.orderId &&
      r.status === args.where.status &&
      r.createdAt.getTime() <= args.where.createdAt.lte.getTime()
    ) {
      r.status = args.data.status;
      count++;
    }
  }
  return Promise.resolve({ count });
}

const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-30T18:05:12.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  m.updateMany.mockImplementation(fakeUpdateMany);
  table = [
    { id: "antes", orderId: "order-1", status: "pending", createdAt: at("2026-10-30T17:40:00.000Z") },
    { id: "tarde", orderId: "order-1", status: "pending", createdAt: at("2026-10-30T18:30:00.000Z") },
    { id: "rechazada", orderId: "order-1", status: "rejected", createdAt: at("2026-10-30T17:00:00.000Z") },
    { id: "otra-orden", orderId: "order-2", status: "pending", createdAt: at("2026-10-30T17:00:00.000Z") },
  ];
});

const statusOf = (id: string) => table.find((r) => r.id === id)!.status;

describe("cierre al aceptarse (riel síncrono)", () => {
  it("pasa a generated las pendientes hasta el corte, con la fecha de la aceptación", async () => {
    const closed = await closeInvoiceRequestsOnAcceptance({
      orderId: "order-1",
      cutoff: at("2026-10-30T17:40:00.000Z"),
      now: NOW,
    });
    expect(closed).toBe(1);
    expect(statusOf("antes")).toBe("generated");
    expect(m.updateMany).toHaveBeenCalledWith({
      where: { orderId: "order-1", status: "pending", createdAt: { lte: at("2026-10-30T17:40:00.000Z") } },
      data: { status: "generated", generatedAt: NOW, generatedByEmail: null },
    });
  });

  it("NO cierra la que llegó tarde, ni la rechazada, ni las de otra cuenta", async () => {
    await closeInvoiceRequestsOnAcceptance({ orderId: "order-1", cutoff: at("2026-10-30T17:40:00.000Z"), now: NOW });
    expect(statusOf("tarde")).toBe("pending");
    expect(statusOf("rechazada")).toBe("rejected");
    expect(statusOf("otra-orden")).toBe("pending");
  });

  it("sin corte (factura a consumidor final) no toca la base", async () => {
    expect(await closeInvoiceRequestsOnAcceptance({ orderId: "order-1", cutoff: null })).toBe(0);
    expect(await closeInvoiceRequestsOnAcceptance({ orderId: null, cutoff: NOW })).toBe(0);
    expect(m.updateMany).not.toHaveBeenCalled();
  });

  it("un fallo de la base no lanza: la factura ya está aceptada", async () => {
    m.updateMany.mockRejectedValueOnce(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      closeInvoiceRequestsOnAcceptance({ orderId: "order-1", cutoff: NOW }),
    ).resolves.toBe(0);
    spy.mockRestore();
  });
});

describe("cierre al aceptarse (consulta diferida)", () => {
  const xml = (date: string, time: string) =>
    `<Invoice><cbc:IssueDate>${date}</cbc:IssueDate><cbc:IssueTime>${time}</cbc:IssueTime></Invoice>`;

  it("corta en el instante de emisión del XML: lo de antes se cierra, lo de después no", async () => {
    // Emitida 13:00:00 Bogotá = 18:00:00Z.
    const xmlZip = await zipInvoice("FESM7845.xml", xml("2026-10-30", "13:00:00-05:00"));
    const closed = await closeInvoiceRequestsAfterDeferredAcceptance({ orderId: "order-1", xmlZip, now: NOW });
    expect(closed).toBe(1);
    expect(m.updateMany.mock.calls[0][0].where.createdAt.lte).toEqual(at("2026-10-30T18:00:00.000Z"));
    expect(statusOf("antes")).toBe("generated");
    expect(statusOf("tarde")).toBe("pending");
  });

  it("sin XML (o sin fecha de emisión) no cierra nada", async () => {
    expect(await closeInvoiceRequestsAfterDeferredAcceptance({ orderId: "order-1", xmlZip: null })).toBe(0);
    const noDate = await zipInvoice("x.xml", "<Invoice/>");
    expect(await closeInvoiceRequestsAfterDeferredAcceptance({ orderId: "order-1", xmlZip: noDate })).toBe(0);
    expect(
      await closeInvoiceRequestsAfterDeferredAcceptance({ orderId: "order-1", xmlZip: Buffer.from("no zip") }),
    ).toBe(0);
    expect(m.updateMany).not.toHaveBeenCalled();
    expect(table.every((r) => r.status !== "generated")).toBe(true);
  });
});
