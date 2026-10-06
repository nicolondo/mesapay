// Pantalla de notas crédito: una nota ACEPTADA muestra si ya quedó
// contabilizada (y en qué mes) o si está pendiente — con el aviso de mes
// fiscal cerrado cuando va al primer mes abierto. Sin módulo de
// contabilidad (o sin aceptación) no se muestra nada.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  notes: [] as unknown[],
  modules: ["einvoicing", "accounting"] as string[],
  closedThrough: null as string | null,
  ensure: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    restaurant: { findUnique: async () => ({ enabledModules: m.modules }) },
    creditNote: {
      findMany: async () => m.notes,
      findFirst: async () => m.notes[0] ?? null,
    },
  },
}));
vi.mock("@/lib/erp/cierre", () => ({
  getAccountingConfig: async () => ({ uvtCents: 0, closedThrough: m.closedThrough, nextVoucherNumber: 1 }),
}));
vi.mock("@/lib/erp/creditNoteAccounting", async (original) => ({
  ...(await original<typeof import("@/lib/erp/creditNoteAccounting")>()),
  ensureCreditNoteStamps: m.ensure,
}));

import { getCreditNote, listCreditNotes } from "./service";

function note(over: { state?: string; issuedAt?: string; postedMonth?: string | null; abandonedAt?: Date | null } = {}) {
  return {
    id: "n1",
    publicToken: "tok",
    originalInvoiceId: "i1",
    documentNumber: "NC1",
    number: 1,
    reasonCode: "1",
    reasonText: "Devolución",
    subtotalCents: 10_000,
    taxCents: 1_900,
    totalCents: 11_900,
    createdAt: new Date("2026-09-20T15:00:00Z"),
    abandonedAt: over.abandonedAt ?? null,
    postedMonth: over.postedMonth ?? null,
    snapshot: { lines: [] },
    series: { environment: "2" },
    dianDocument: {
      id: "d1",
      state: over.state ?? "accepted",
      cufe: "c",
      trackId: null,
      errors: null,
      lastError: null,
      issuedAt: new Date(over.issuedAt ?? "2026-09-20T15:00:00Z"),
      emailedAt: null,
      emailError: null,
      leaseExpiresAt: null,
      xmlZip: Buffer.from("x"),
      attempts: 1,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.modules = ["einvoicing", "accounting"];
  m.closedThrough = null;
  m.notes = [note()];
});

describe("estado contable en la pantalla de la nota", () => {
  it("ya asentada: «Contabilizada en <mes>»", async () => {
    m.notes = [note({ postedMonth: "2026-09" })];
    expect((await getCreditNote("r1", "n1")).accounting).toEqual({ status: "posted", month: "2026-09" });
    expect(m.ensure).toHaveBeenCalledWith("r1");
  });

  it("mes fiscal abierto sin generar: pendiente en su mes", async () => {
    expect((await listCreditNotes("r1"))[0]!.accounting).toEqual({ status: "pending", month: "2026-09" });
  });

  it("mes fiscal cerrado: pendiente, se contabiliza en el primer mes abierto", async () => {
    m.closedThrough = "2026-09";
    expect((await getCreditNote("r1", "n1")).accounting).toEqual({
      status: "pending_closed",
      month: "2026-10",
      fiscalMonth: "2026-09",
    });
  });

  it("sin aceptación, descartada o sin módulo de contabilidad: no se muestra", async () => {
    m.notes = [note({ state: "rejected" })];
    expect((await getCreditNote("r1", "n1")).accounting).toBeNull();
    m.notes = [note({ abandonedAt: new Date() })];
    expect((await getCreditNote("r1", "n1")).accounting).toBeNull();
    m.notes = [note()];
    m.modules = ["einvoicing"];
    expect((await getCreditNote("r1", "n1")).accounting).toBeNull();
    // La cartera de cliente igual se repara aunque no lleve contabilidad.
    expect(m.ensure).toHaveBeenCalled();
  });
});
