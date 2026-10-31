// «Descartar y emitir de nuevo»: en una transacción se descarta la nota
// fallida y se crea su reemplazo (misma factura, motivo, explicación e
// importes) en la serie sin conflicto. Datos sintéticos.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nc1NotReceived, nc3Conflict, ncm1Accepted } from "../__fixtures__/creditNoteFailures";

type Row = Record<string, unknown> & { id: string };
const store = vi.hoisted(() => ({ series: [] as Array<{ id: string; issuerNit: string; environment: string; prefix: string; nextNumber: number }>, notes: [] as Array<Record<string, unknown> & { id: string }>, audits: [] as unknown[], documentWrites: [] as unknown[], configuredPrefix: "NC" }));
const original = { currency: "COP", invoiceNumber: "FE7677", cufe: "a".repeat(96), issueDate: "2026-10-01", issueTime: "10:00:00-05:00", environment: "1", supplier: { name: "Emisor prueba", companyId: "900373076" }, customer: { name: "Cliente", companyId: "222222222", email: "cliente@example.test" }, lines: [{ lineId: "1", description: "Plato", quantity: 1, unitPriceCents: 10000, lineTotalCents: 10000, taxCents: 800, taxPct: "8.00", taxSchemeId: "04", grossCents: 10800 }], totals: {}, paymentMeansCode: "10", paymentMeansId: "1" };
const credited = [{ originalLineId: "1", description: "Plato", quantity: 1, unitPriceCents: 10000, lineTotalCents: 10000, taxCents: 800, taxPct: "8.00", taxSchemeId: "04", grossCents: 10800 }];

const seriesOf = (id: unknown) => store.series.find(series => series.id === id)!;
const withIncludes = (note: Row) => ({ ...note, series: seriesOf(note.seriesId) });
const tx = {
  $executeRaw: vi.fn(async () => 1),
  $queryRaw: vi.fn(async () => []),
  user: { findUnique: vi.fn(async () => null) },
  auditEvent: { create: vi.fn(async ({ data }: { data: unknown }) => { store.audits.push(data); return data; }) },
  simpleInvoice: { findFirst: vi.fn(async () => ({ id: "inv", orderId: "order1", email: null, order: { locale: "es" }, dianDocument: { id: "invdoc", kind: "invoice", state: "accepted", xmlZip: Buffer.from("zip"), cufe: original.cufe }, restaurant: { name: "Prueba", taxId: "900373076-4", invoicePrefix: "FE", legalEntityId: null, legalEntity: null, dianConfig: { id: "cfg", environment: "produccion", creditNotePrefix: store.configuredPrefix } } })) },
  dianDocument: { updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => { store.documentWrites.push(args); const note = store.notes.find(n => (n.dianDocument as Row).id === args.where.id)!; Object.assign(note.dianDocument as Row, args.data); return { count: 1 }; }) },
  creditNoteSeries: {
    findMany: vi.fn(async () => store.series.map(({ id, prefix, nextNumber }) => ({ id, prefix, nextNumber }))),
    upsert: vi.fn(async ({ where }: { where: { issuerNit_environment_prefix: { prefix: string } } }) => store.series.find(series => series.prefix === where.issuerNit_environment_prefix.prefix)!),
    updateMany: vi.fn(async ({ where }: { where: { id: string } }) => { seriesOf(where.id).nextNumber++; return { count: 1 }; }),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({ ...seriesOf(where.id) })),
  },
  creditNote: {
    findUnique: vi.fn(async ({ where }: { where: { restaurantId_requestId?: { requestId: string }; fiscalKey?: string } }) => {
      const found = where.restaurantId_requestId ? store.notes.find(note => note.requestId === where.restaurantId_requestId!.requestId) : store.notes.find(note => note.fiscalKey === where.fiscalKey);
      return found ? withIncludes(found) : null;
    }),
    findFirst: vi.fn(async ({ where }: { where: { id: string } }) => store.notes.find(note => note.id === where.id) ?? null),
    findFirstOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => withIncludes(store.notes.find(note => note.id === where.id)!)),
    findMany: vi.fn(async ({ where }: { where: { originalInvoiceId: string } }) => store.notes.filter(note => note.originalInvoiceId === where.originalInvoiceId).map(withIncludes)),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => { const note = store.notes.find(n => n.id === where.id)!; Object.assign(note, data); return withIncludes(note); }),
    aggregate: vi.fn(async ({ where }: { where: { seriesId: string; abandonedAt?: null; dianDocument: { is: { lastError?: string; state?: string } } } }) => {
      const rows = store.notes.filter(note => note.seriesId === where.seriesId && (where.abandonedAt !== null || !note.abandonedAt) && Object.entries(where.dianDocument.is).every(([field, value]) => (note.dianDocument as Row)[field] === value));
      return { _max: { number: rows.length ? Math.max(...rows.map(row => row.number as number)) : null, createdAt: rows.length ? rows.map(row => row.createdAt as Date).sort((a, b) => b.getTime() - a.getTime())[0] : null } };
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> & { documentNumber: string; dianDocument: { create: Record<string, unknown> } } }) => { const note = { ...data, id: `new-${data.documentNumber}`, createdAt: new Date(), abandonedAt: null, publicToken: "tok", dianDocument: { ...data.dianDocument.create, id: `doc-${data.documentNumber}`, xmlZip: null, attempts: 0, leaseExpiresAt: null, lastError: null, errors: null } }; store.notes.push(note); return withIncludes(note); }),
  },
};
vi.mock("@/lib/db", () => ({ db: { $transaction: async (work: (client: unknown) => Promise<unknown>) => work(tx) } }));
vi.mock("../soap", async actual => ({ ...await actual<typeof import("../soap")>(), unzipFirstXml: async () => "<Invoice/>" }));
vi.mock("../creditNoteSource", () => ({ parseAcceptedInvoiceXml: () => original }));
vi.mock("@/lib/erp/cierre", () => ({ getAccountingConfig: vi.fn() }));
vi.mock("@/lib/erp/creditNoteAccounting", () => ({ creditNoteInstant: vi.fn(), ensureCreditNoteStamps: vi.fn() }));
import { reissueCreditNote } from "./service";

const note = (id: string, seriesId: string, number: number, document: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ id, restaurantId: "r1", originalInvoiceId: "inv", seriesId, number, documentNumber: `${seriesOf(seriesId).prefix}${number}`, fiscalKey: `900373076:1:${seriesOf(seriesId).prefix}${number}`, requestId: `req-${id}`, reasonCode: "3", reasonText: "Descuento acordado con el cliente", snapshot: { version: 1, original, lines: credited }, subtotalCents: 10000, taxCents: 800, totalCents: 10800, createdAt: new Date("2026-10-20T15:00:00Z"), abandonedAt: null, publicToken: "tok", dianDocument: { id: `doc-${id}`, updatedAt: new Date("2026-10-20T15:00:00Z"), ...document }, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  store.configuredPrefix = "NC"; store.audits = []; store.documentWrites = [];
  store.series = [{ id: "s-nc", issuerNit: "900373076", environment: "1", prefix: "NC", nextNumber: 4 }, { id: "s-ncm", issuerNit: "900373076", environment: "1", prefix: "NCM", nextNumber: 2 }];
  store.notes = [];
  // NC1 no recibida, NC2 conflicto ya descartado (a mano, estado error), NC3 conflicto, NCM1 aceptada (otra factura).
  store.notes.push(note("nc1", "s-nc", 1, { ...nc1NotReceived }, { originalInvoiceId: "other-1" }));
  store.notes.push(note("nc2", "s-nc", 2, { ...nc3Conflict }, { originalInvoiceId: "other-2", abandonedAt: new Date("2026-10-27T15:00:00Z") }));
  store.notes.push(note("nc3", "s-nc", 3, { ...nc3Conflict }));
  store.notes.push(note("ncm1", "s-ncm", 1, { ...ncm1Accepted }, { originalInvoiceId: "other-2" }));
});

describe("descartar y emitir de nuevo", () => {
  it("NC3 queda descartada y su reemplazo sale como NCM2 aunque NC siga configurada", async () => {
    const replacement = await reissueCreditNote("r1", "nc3", null);
    expect(replacement).toMatchObject({ documentNumber: "NCM2", number: 2, originalInvoiceId: "inv", reasonCode: "3", reasonText: "Descuento acordado con el cliente", totalCents: 10800, canRetry: true });
    expect(replacement.snapshot.lines.map(line => [line.originalLineId, line.grossCents])).toEqual([["1", 10800]]);
    expect(tx.creditNote.create.mock.calls[0][0].data).toMatchObject({ seriesId: "s-ncm", requestId: "reissue:nc3", fiscalKey: "900373076:1:NCM2" });
    // La nota vieja se descarta comparando el estado leído; no se borra.
    expect(store.documentWrites[0]).toMatchObject({ where: { id: "doc-nc3", state: "error", lastError: "dian_numbering_conflict" }, data: { state: "abandoned", nextAttemptAt: null } });
    expect(store.notes.find(n => n.id === "nc3")?.abandonedAt).toBeInstanceOf(Date);
    expect(store.series.find(series => series.prefix === "NC")?.nextNumber).toBe(4);
    expect(store.audits).toEqual([
      expect.objectContaining({ kind: "credit_note.abandon", targetId: "nc3" }),
      expect.objectContaining({ kind: "credit_note.create", summary: "Credit note NCM2 replaces NC3", diff: expect.objectContaining({ replacesCreditNoteId: "nc3" }) }),
    ]);
  });
  it("NC1 «No recibida por la DIAN» también se reemite en NCM", async () => {
    store.notes.find(n => n.id === "nc1")!.originalInvoiceId = "inv";
    store.notes.find(n => n.id === "nc3")!.originalInvoiceId = "other-3";
    expect((await reissueCreditNote("r1", "nc1", null)).documentNumber).toBe("NCM2");
    expect(store.documentWrites[0]).toMatchObject({ where: { id: "doc-nc1", lastError: "dian_not_received" } });
  });
  it("es idempotente: repetir la solicitud devuelve el mismo reemplazo", async () => {
    const first = await reissueCreditNote("r1", "nc3", null);
    const again = await reissueCreditNote("r1", "nc3", null);
    expect(again.id).toBe(first.id);
    expect(tx.creditNote.create).toHaveBeenCalledTimes(1);
    expect(store.series.find(series => series.prefix === "NCM")?.nextNumber).toBe(3);
  });
  it("no reemite una nota ya descartada (NC2 ya se reemplazó por otro camino)", async () => {
    await expect(reissueCreditNote("r1", "nc2", null)).rejects.toThrow("cannot_reissue");
    expect(tx.creditNote.create).not.toHaveBeenCalled();
  });
  it("no descarta ni reemite una nota aceptada (NCM1)", async () => {
    await expect(reissueCreditNote("r1", "ncm1", null)).rejects.toThrow("cannot_abandon");
    expect(tx.dianDocument.updateMany).not.toHaveBeenCalled();
  });
  it("sin una serie aceptada y sin conflicto, se niega a emitir en la serie rechazada", async () => {
    store.notes = store.notes.filter(n => n.id !== "ncm1");
    await expect(reissueCreditNote("r1", "nc3", null)).rejects.toThrow("series_in_conflict");
    expect(tx.creditNote.create).not.toHaveBeenCalled();
  });
});
