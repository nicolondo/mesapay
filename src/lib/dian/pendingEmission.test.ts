// "N facturas esperando emisión — falta X": el resumen puro que alimenta
// el aviso rojo de /operator/facturas y la tarjeta del hub.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { NUMBERS_LEFT_WARNING, summarizePendingEmission } from "./pendingEmission";

const EMISOR = { resolutionTo: 10000, invoiceNextNumber: 6485 };

describe("summarizePendingEmission", () => {
  it("sin nada esperando ni rango bajo ⇒ todo en cero", () => {
    expect(summarizePendingEmission([], EMISOR)).toEqual({
      waiting: 0,
      blockedBy: null,
      blockedCount: 0,
      numbersLeft: 3516,
    });
  });

  it("separa lo frenado por el comercio de lo que sólo espera reintento", () => {
    const s = summarizePendingEmission(
      [
        { lastError: "contact_email_incomplete", count: 7 },
        { lastError: "resolution_incomplete", count: 2 },
        // Errores de canal: esperan backoff, no frenan al comercio.
        { lastError: null, count: 3 },
      ],
      EMISOR,
    );
    expect(s.waiting).toBe(12);
    expect(s.blockedCount).toBe(9);
    // El motivo dominante es el que se muestra.
    expect(s.blockedBy).toBe("contact_email_incomplete");
  });

  it("numbering_exhausted cuenta como bloqueo del comercio", () => {
    const s = summarizePendingEmission([{ lastError: "numbering_exhausted", count: 4 }], {
      resolutionTo: 10000,
      invoiceNextNumber: 10001,
    });
    expect(s).toEqual({
      waiting: 4,
      blockedBy: "numbering_exhausted",
      blockedCount: 4,
      numbersLeft: 0,
    });
  });

  it("no_lines y number_out_of_range son del documento, no del comercio", () => {
    const s = summarizePendingEmission(
      [
        { lastError: "no_lines", count: 1 },
        { lastError: "number_out_of_range", count: 1 },
      ],
      EMISOR,
    );
    expect(s.waiting).toBe(2);
    expect(s.blockedCount).toBe(0);
    expect(s.blockedBy).toBeNull();
  });

  it("números que quedan: cuenta el próximo a emitir; sin tope ⇒ null", () => {
    expect(summarizePendingEmission([], { resolutionTo: 10, invoiceNextNumber: 10 }).numbersLeft).toBe(1);
    expect(summarizePendingEmission([], { resolutionTo: 10, invoiceNextNumber: 11 }).numbersLeft).toBe(0);
    expect(summarizePendingEmission([], { resolutionTo: 10, invoiceNextNumber: 50 }).numbersLeft).toBe(0);
    expect(summarizePendingEmission([], { resolutionTo: null, invoiceNextNumber: 5 }).numbersLeft).toBeNull();
    expect(summarizePendingEmission([], null).numbersLeft).toBeNull();
  });

  it("el umbral del aviso amarillo es 500", () => {
    expect(NUMBERS_LEFT_WARNING).toBe(500);
  });
});
