// Recuperación de facturas rechazadas: la acción que corresponde a cada
// causa, el número que NO cambia, el audit de cada reenvío/consulta, y el
// lote del admin (listado sin efectos, sólo lo accionable, idempotente).
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  emit: vi.fn(),
  check: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { dianDocument: { findUnique: m.findUnique, findMany: m.findMany } } }));
vi.mock("@/lib/dian/emitInvoice", () => ({ emitDianInvoice: m.emit }));
vi.mock("@/lib/dian/invoiceReconcile", () => ({ checkDianInvoiceStatus: m.check }));
vi.mock("@/lib/auditLog", () => ({ recordAuditEvent: m.audit }));

import { listRecoverableInvoices, recoverableWhere, recoverDianInvoice, recoverRestaurantInvoices } from "./invoiceRecovery";
import { DUPLICATE_UNVERIFIED } from "./invoiceResponse";
import { MAX_ATTEMPTS } from "./retry";

const FAW01 = "Regla: FAW01, Rechazo: Línea de factura informado con LineExtensionAmount en cero";
const RULE_90 = "Regla: 90, Rechazo: Documento procesado anteriormente.";
const RUT01_NOTICE = "Regla: RUT01, Notificación: La validación del estado del RUT próximamente estará disponible.";
const FAB10A = "Regla: FAB10a, Rechazo: El prefijo de numeración no es igual al código de la sucursal";
const NOW = new Date("2026-11-04T18:00:00.000Z");

function doc(id: string, errors: string[], over: Record<string, unknown> = {}) {
  return {
    id,
    restaurantId: "rest-1",
    kind: "invoice",
    state: "rejected",
    cufe: "a".repeat(96),
    lastError: errors[0] ?? null,
    errors,
    attempts: 1,
    simpleInvoice: {
      id: `inv-${id}`,
      invoiceNumber: 7913,
      snapshot: { invoicePrefix: "FESM" },
      createdAt: new Date("2026-10-01T18:00:00Z"),
      totalCents: 100_00,
    },
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  m.audit.mockResolvedValue(undefined);
});

describe("recoverDianInvoice", () => {
  it("FAW01 ⇒ reenvío por la emisión de siempre: MISMA factura (mismo número), sin papel por ser vieja, y queda auditado", async () => {
    m.findUnique
      .mockResolvedValueOnce(doc("d1", [FAW01]))
      .mockResolvedValueOnce({ state: "accepted", cufe: "b".repeat(96), lastError: null, attempts: 2 });
    m.emit.mockResolvedValue({ outcome: "accepted", documentId: "d1", cufe: "b".repeat(96), qrUrl: "q", errors: [], statusMessage: null });

    const r = await recoverDianInvoice({ documentId: "d1", restaurantId: "rest-1", action: "resend", now: NOW, source: "operator" });

    expect(r).toEqual({ documentId: "d1", number: "FESM7913", action: "resend", outcome: "accepted", reason: null });
    expect(m.emit).toHaveBeenCalledWith({ simpleInvoiceId: "inv-d1", restaurantId: "rest-1", now: NOW, printOnAccept: false });
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "dian.invoice.resend",
        restaurantId: "rest-1",
        target: { type: "dian_document", id: "d1" },
        diff: {
          before: expect.objectContaining({ number: "FESM7913", state: "rejected", cufe: "a".repeat(96), cause: "zero_value_line" }),
          after: expect.objectContaining({ state: "accepted", cufe: "b".repeat(96), outcome: "accepted", source: "operator" }),
        },
      }),
    );
  });

  it("regla 90 ⇒ consulta por CUFE (nunca un reenvío)", async () => {
    m.findUnique.mockResolvedValueOnce(doc("d2", [RULE_90])).mockResolvedValueOnce({ state: "accepted" });
    m.check.mockResolvedValue({ outcome: "accepted", documentId: "d2", cufe: "a".repeat(96), qrUrl: "q", warnings: [] });
    const r = await recoverDianInvoice({ documentId: "d2", restaurantId: "rest-1", action: "check_status", now: NOW, source: "operator" });
    expect(r.outcome).toBe("accepted");
    expect(m.check).toHaveBeenCalledWith(expect.objectContaining({ documentId: "d2", restaurantId: "rest-1" }));
    expect(m.emit).not.toHaveBeenCalled();
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "dian.invoice.status_check" }));
  });

  it("la acción tiene que ser la de su causa: reenviar una que la DIAN ya tiene ⇒ not_applicable, sin tocar nada", async () => {
    m.findUnique.mockResolvedValue(doc("d3", [RULE_90]));
    const r = await recoverDianInvoice({ documentId: "d3", restaurantId: "rest-1", action: "resend", source: "operator" });
    expect(r.outcome).toBe("not_applicable");
    expect(m.emit).not.toHaveBeenCalled();
    expect(m.check).not.toHaveBeenCalled();
  });

  it("un rechazo real (FAB10a) no tiene acción nueva", async () => {
    m.findUnique.mockResolvedValue(doc("d4", [FAB10A]));
    expect((await recoverDianInvoice({ documentId: "d4", restaurantId: "rest-1", action: "resend", source: "operator" })).outcome).toBe("not_applicable");
  });

  it("ya aceptada ⇒ already; de otro comercio ⇒ not_found", async () => {
    m.findUnique.mockResolvedValue(doc("d5", [], { state: "accepted" }));
    expect((await recoverDianInvoice({ documentId: "d5", restaurantId: "rest-1", action: "resend", source: "operator" })).outcome).toBe("already");
    m.findUnique.mockResolvedValue(doc("d5", [FAW01], { restaurantId: "otro" }));
    expect((await recoverDianInvoice({ documentId: "d5", restaurantId: "rest-1", action: "resend", source: "operator" })).outcome).toBe("not_found");
    expect(m.emit).not.toHaveBeenCalled();
  });

  it("el nuevo rechazo trae su motivo; reclamada por otro ⇒ already", async () => {
    m.findUnique.mockResolvedValue(doc("d6", [RUT01_NOTICE]));
    m.emit.mockResolvedValueOnce({ outcome: "rejected", documentId: "d6", cufe: null, qrUrl: null, errors: [FAB10A], statusMessage: null });
    expect(await recoverDianInvoice({ documentId: "d6", restaurantId: "rest-1", action: "resend", source: "operator" })).toMatchObject({
      outcome: "rejected",
      reason: FAB10A,
    });
    m.emit.mockResolvedValueOnce({ outcome: "already_emitted" });
    expect((await recoverDianInvoice({ documentId: "d6", restaurantId: "rest-1", action: "resend", source: "operator" })).outcome).toBe("already");
  });
});

describe("listado del lote (dry-run)", () => {
  it("lista las rechazadas, las que agotaron reintentos y las sin confirmar, con causa y acción; no llama a la DIAN", async () => {
    m.findMany.mockResolvedValue([
      doc("a", [FAW01]),
      doc("b", [RULE_90]),
      doc("c", [RUT01_NOTICE], { state: "error", attempts: MAX_ATTEMPTS }),
      doc("d", [FAB10A]),
      doc("e", [RULE_90], { state: "pending", lastError: DUPLICATE_UNVERIFIED }),
    ]);
    const { items, counts } = await listRecoverableInvoices("rest-1");
    expect(m.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: recoverableWhere("rest-1") }));
    expect(items.map((i) => [i.documentId, i.cause, i.action])).toEqual([
      ["a", "zero_value_line", "resend"],
      ["b", "already_at_dian", "check_status"],
      ["c", "dian_notification", "resend"],
      ["d", "other", "none"],
      ["e", "already_at_dian", "check_status"],
    ]);
    expect(items[0].number).toBe("FESM7913");
    expect(counts).toEqual({ zero_value_line: 1, already_at_dian: 2, dian_notification: 1, dian_transient: 0, other: 1 });
    expect(m.emit).not.toHaveBeenCalled();
    expect(m.check).not.toHaveBeenCalled();
  });

  it("el filtro sólo toma facturas de venta con tirilla de ESE comercio", () => {
    expect(recoverableWhere("rest-1")).toMatchObject({ restaurantId: "rest-1", kind: "invoice", simpleInvoiceId: { not: null } });
  });
});

describe("recoverRestaurantInvoices (lote)", () => {
  it("procesa sólo lo accionable, con tope, y deja constancia de la corrida", async () => {
    const docs = [doc("a", [FAW01]), doc("d", [FAB10A]), doc("b", [RULE_90]), doc("c", [FAW01])];
    m.findMany.mockResolvedValue(docs);
    m.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => docs.find((d) => d.id === where.id) ?? null);
    m.emit.mockResolvedValue({ outcome: "accepted", documentId: "x", cufe: "c", qrUrl: "q", errors: [], statusMessage: null });
    m.check.mockResolvedValue({ outcome: "accepted", documentId: "b", cufe: "c", qrUrl: "q", warnings: [] });

    const run = await recoverRestaurantInvoices({ restaurantId: "rest-1", limit: 2, pauseMs: 0 });
    expect(run.results.map((r) => [r.documentId, r.action, r.outcome])).toEqual([
      ["a", "resend", "accepted"],
      ["b", "check_status", "accepted"],
    ]);
    expect(run.remaining).toBe(1); // "c"; "d" (FAB10a) no es accionable
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ kind: "dian.invoice.recovery_batch", restaurantId: "rest-1" }));
  });

  it("idempotente: con todo aceptado no queda nada que procesar", async () => {
    m.findMany.mockResolvedValue([]);
    const run = await recoverRestaurantInvoices({ restaurantId: "rest-1", pauseMs: 0 });
    expect(run).toEqual({ results: [], remaining: 0, truncated: false });
    expect(m.emit).not.toHaveBeenCalled();
  });
});
