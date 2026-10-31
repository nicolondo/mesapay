import { describe, expect, it } from "vitest";
import { creditNoteDisplayState, detailErrorMessages, visibleCreditNotes } from "./creditNoteList";

const doc = (state: string, lastError: string | null = null, errors: string[] = []) => ({ id: "d", state, cufe: null, trackId: null, errors, lastError, issuedAt: null, emailedAt: null, emailError: null });
// La lista real de la captura: NC3 rechazada, NC2 descartada, NC1 sin recibir, NCM1 aceptada.
const notes = [
  { id: "ncm1", documentNumber: "NCM1", abandonedAt: null, failure: null, document: doc("accepted") },
  { id: "nc3", documentNumber: "NC3", abandonedAt: null, failure: "numbering_conflict" as const, document: doc("error", "dian_numbering_conflict", ["dian_numbering_conflict", "Regla: 90, Rechazo: Documento procesado anteriormente."]) },
  { id: "nc2", documentNumber: "NC2", abandonedAt: "2026-10-27T15:00:00.000Z", failure: "numbering_conflict" as const, document: doc("error", "dian_numbering_conflict") },
  { id: "nc1", documentNumber: "NC1", abandonedAt: null, failure: "not_received" as const, document: doc("error", "dian_not_received", ["dian_not_received"]) },
];

describe("lista de notas crédito", () => {
  it("oculta las descartadas por defecto y las cuenta para «Ver descartadas (N)»", () => {
    const { visible, abandonedCount } = visibleCreditNotes(notes, false);
    expect(visible.map(note => note.documentNumber)).toEqual(["NCM1", "NC3", "NC1"]);
    expect(abandonedCount).toBe(1);
  });
  it("las muestra todas, en el mismo orden, al pedirlo", () => {
    expect(visibleCreditNotes(notes, true).visible.map(note => note.documentNumber)).toEqual(["NCM1", "NC3", "NC2", "NC1"]);
  });
  it("sin descartadas no hay nada que contar", () => {
    expect(visibleCreditNotes(notes.filter(note => !note.abandonedAt), false).abandonedCount).toBe(0);
  });
});

describe("estado visible de la nota", () => {
  it("una nota sin salida no se muestra como error de envío", () => {
    expect(notes.map(creditNoteDisplayState)).toEqual(["accepted", "rejected", "abandoned", "not_received"]);
  });
  it("conserva los estados conocidos y trata lo desconocido como pendiente", () => {
    expect(creditNoteDisplayState({ abandonedAt: null, failure: null, document: doc("error", "transport_error") })).toBe("error");
    expect(creditNoteDisplayState({ abandonedAt: null, document: null })).toBe("draft");
    expect(creditNoteDisplayState({ abandonedAt: null, failure: null, document: doc("weird") })).toBe("pending");
  });
  it("el detalle no repite el marcador interno, pero conserva la regla DIAN", () => {
    expect(detailErrorMessages(notes[1].document, "numbering_conflict")).toEqual(["Regla: 90, Rechazo: Documento procesado anteriormente."]);
    expect(detailErrorMessages(notes[3].document, "not_received")).toEqual([]);
    expect(detailErrorMessages(doc("error", "transport_error", ["transport_error"]), null)).toEqual(["transport_error"]);
  });
});
