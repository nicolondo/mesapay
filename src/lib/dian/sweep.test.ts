// El barrido: toma lo que espera, emite uno por uno, no re-evalúa una
// config rota cien veces, y un documento roto no tapa la cola.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  emitDianInvoice: vi.fn(),
  markDocumentBlocked: vi.fn(async () => undefined),
  issueInvoiceOnPaid: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { dianDocument: { findMany: m.findMany } } }));
vi.mock("@/lib/dian/emitInvoice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dian/emitInvoice")>()),
  emitDianInvoice: m.emitDianInvoice,
  markDocumentBlocked: m.markDocumentBlocked,
}));
vi.mock("@/lib/invoiceOnPaid", () => ({ issueInvoiceOnPaid: m.issueInvoiceOnPaid }));

import { sweepDianEmissions } from "./sweep";
import { claimableDianWhere } from "./retry";

const NOW = new Date("2026-09-15T20:00:00.000Z");

type Row = {
  id: string;
  restaurantId: string;
  simpleInvoiceId: string | null;
  orderId: string | null;
};
const doc = (id: string, restaurantId = "rest-1", over: Partial<Row> = {}): Row => ({
  id,
  restaurantId,
  simpleInvoiceId: `inv-${id}`,
  orderId: `order-${id}`,
  ...over,
});

const sent = (outcome: "accepted" | "pending" | "rejected" | "error") => ({
  outcome,
  documentId: "x",
  cufe: null,
  qrUrl: null,
  errors: [],
  statusMessage: null,
});

beforeEach(() => {
  vi.resetAllMocks();
  m.findMany.mockResolvedValue([]);
  m.emitDianInvoice.mockResolvedValue(sent("accepted"));
  m.markDocumentBlocked.mockResolvedValue(undefined);
});

describe("sweepDianEmissions", () => {
  it("consulta con el filtro de reintento, en orden de creación y por lotes", async () => {
    await sweepDianEmissions({ now: NOW, limit: 7 });
    expect(m.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: claimableDianWhere(NOW),
        orderBy: { createdAt: "asc" },
        take: 7,
      }),
    );
  });

  it("emite cada documento y cuenta lo que dijo la DIAN", async () => {
    m.findMany.mockResolvedValue([doc("a"), doc("b"), doc("c"), doc("d")]);
    m.emitDianInvoice
      .mockResolvedValueOnce(sent("accepted"))
      .mockResolvedValueOnce(sent("pending"))
      .mockResolvedValueOnce(sent("error"))
      .mockResolvedValueOnce({ outcome: "already_emitted" });
    const s = await sweepDianEmissions({ now: NOW });
    expect(m.emitDianInvoice).toHaveBeenCalledTimes(4);
    expect(m.emitDianInvoice).toHaveBeenCalledWith({
      simpleInvoiceId: "inv-a",
      restaurantId: "rest-1",
      now: NOW,
    });
    expect(s).toEqual({
      scanned: 4,
      accepted: 1,
      pending: 1,
      rejected: 0,
      error: 1,
      blocked: 0,
      skipped: 1,
      truncated: false,
    });
  });

  it("config rota en un comercio: el primero la detecta, los demás del comercio se marcan sin emitir", async () => {
    m.findMany.mockResolvedValue([
      doc("a", "rest-1"),
      doc("b", "rest-2"),
      doc("c", "rest-1"),
      doc("d", "rest-1"),
    ]);
    m.emitDianInvoice.mockImplementation(async ({ restaurantId }: { restaurantId: string }) =>
      restaurantId === "rest-1"
        ? { outcome: "blocked", reason: "contact_email_incomplete", missing: ["contactEmail"] }
        : sent("accepted"),
    );
    const s = await sweepDianEmissions({ now: NOW });
    // rest-1: sólo "a" pasó por el emit; "c" y "d" se marcaron directo.
    expect(m.emitDianInvoice).toHaveBeenCalledTimes(2);
    expect(m.markDocumentBlocked).toHaveBeenCalledTimes(2);
    expect(m.markDocumentBlocked).toHaveBeenCalledWith("c", "contact_email_incomplete", NOW);
    expect(m.markDocumentBlocked).toHaveBeenCalledWith("d", "contact_email_incomplete", NOW);
    expect(s).toMatchObject({ scanned: 4, accepted: 1, blocked: 3 });
  });

  it("un bloqueo puntual (no_lines) no frena al resto del comercio", async () => {
    m.findMany.mockResolvedValue([doc("a"), doc("b")]);
    m.emitDianInvoice
      .mockResolvedValueOnce({ outcome: "blocked", reason: "no_lines", missing: [] })
      .mockResolvedValueOnce(sent("accepted"));
    const s = await sweepDianEmissions({ now: NOW });
    expect(m.emitDianInvoice).toHaveBeenCalledTimes(2);
    expect(m.markDocumentBlocked).not.toHaveBeenCalled();
    expect(s).toMatchObject({ blocked: 1, accepted: 1 });
  });

  it("placeholder de numbering_exhausted: vuelve a pasar por el riel del cobro, en línea", async () => {
    m.findMany.mockResolvedValue([doc("p", "rest-1", { simpleInvoiceId: null, orderId: "order-p" })]);
    m.issueInvoiceOnPaid.mockResolvedValue({
      status: "issued",
      invoiceId: "inv-p",
      alreadyIssued: false,
      emit: sent("accepted"),
    });
    const s = await sweepDianEmissions({ now: NOW });
    expect(m.issueInvoiceOnPaid).toHaveBeenCalledWith({
      tenantId: "rest-1",
      orderId: "order-p",
      emit: "inline",
    });
    expect(m.emitDianInvoice).not.toHaveBeenCalled();
    expect(s).toMatchObject({ accepted: 1, blocked: 0 });
  });

  it("placeholder que sigue sin rango: cuenta como bloqueado y NO marca al comercio entero", async () => {
    m.findMany.mockResolvedValue([
      doc("p", "rest-1", { simpleInvoiceId: null, orderId: "order-p" }),
      doc("q", "rest-1"),
    ]);
    m.issueInvoiceOnPaid.mockResolvedValue({ status: "blocked", reason: "numbering_exhausted" });
    const s = await sweepDianEmissions({ now: NOW });
    // "q" tiene tirilla numerada dentro del rango: sale igual.
    expect(m.emitDianInvoice).toHaveBeenCalledTimes(1);
    expect(m.markDocumentBlocked).not.toHaveBeenCalled();
    expect(s).toMatchObject({ blocked: 1, accepted: 1 });
  });

  it("un documento sin tirilla ni orden se salta", async () => {
    m.findMany.mockResolvedValue([doc("z", "rest-1", { simpleInvoiceId: null, orderId: null })]);
    const s = await sweepDianEmissions({ now: NOW });
    expect(m.issueInvoiceOnPaid).not.toHaveBeenCalled();
    expect(s).toMatchObject({ skipped: 1 });
  });

  it("si un documento revienta, se cuenta y el barrido sigue con el próximo", async () => {
    m.findMany.mockResolvedValue([doc("a"), doc("b")]);
    m.emitDianInvoice
      .mockRejectedValueOnce(new Error("kaboom"))
      .mockResolvedValueOnce(sent("accepted"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = await sweepDianEmissions({ now: NOW });
    expect(s).toMatchObject({ scanned: 2, error: 1, accepted: 1 });
    logged.mockRestore();
  });

  it("respeta el presupuesto de tiempo y avisa que quedó corto", async () => {
    m.findMany.mockResolvedValue([doc("a"), doc("b")]);
    const s = await sweepDianEmissions({ now: NOW, budgetMs: -1 });
    expect(m.emitDianInvoice).not.toHaveBeenCalled();
    expect(s).toMatchObject({ scanned: 0, truncated: true });
  });
});
