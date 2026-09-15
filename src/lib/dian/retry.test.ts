// Reglas puras del reintento de la emisión automática: cuánto esperar y
// qué documentos toma el barrido. Sin DB.
import { describe, expect, it } from "vitest";
import {
  BLOCKED_RETRY_MS,
  claimWhere,
  claimableDianWhere,
  emissionBackoffMs,
  MAX_ATTEMPTS,
  STALE_CLAIM_MS,
} from "./retry";

const NOW = new Date("2026-09-15T20:00:00.000Z");
const MIN = 60_000;

describe("emissionBackoffMs", () => {
  it("duplica desde 2 minutos: 2, 4, 8, 16… y no baja de 2", () => {
    expect(emissionBackoffMs(1)).toBe(2 * MIN);
    expect(emissionBackoffMs(2)).toBe(4 * MIN);
    expect(emissionBackoffMs(3)).toBe(8 * MIN);
    expect(emissionBackoffMs(8)).toBe(256 * MIN);
    expect(emissionBackoffMs(0)).toBe(2 * MIN);
    expect(emissionBackoffMs(-5)).toBe(2 * MIN);
  });

  it("tope de 6 horas", () => {
    expect(emissionBackoffMs(20)).toBe(6 * 60 * MIN);
    expect(emissionBackoffMs(9)).toBe(6 * 60 * MIN);
  });

  it("los MAX_ATTEMPTS reintentos caben en una jornada", () => {
    let total = 0;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) total += emissionBackoffMs(i);
    expect(total).toBeLessThan(24 * 60 * MIN);
    expect(total).toBeGreaterThan(6 * 60 * MIN);
  });

  it("la espera por bloqueo de config es fija y corta", () => {
    expect(BLOCKED_RETRY_MS).toBe(10 * MIN);
    expect(STALE_CLAIM_MS).toBe(15 * MIN);
  });
});

describe("claimableDianWhere", () => {
  const where = claimableDianWhere(NOW);

  it("sólo facturas de venta (con tirilla o con orden): nunca las del set de pruebas", () => {
    expect(where.kind).toBe("invoice");
    expect(where.AND[0]).toEqual({
      OR: [{ simpleInvoiceId: { not: null } }, { orderId: { not: null } }],
    });
  });

  it("to_send y error con el backoff vencido; error sólo bajo el tope", () => {
    const states = (where.AND[1] as { OR: Record<string, unknown>[] }).OR;
    const due = { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: NOW } }] };
    expect(states[0]).toEqual({ state: "to_send", ...due });
    expect(states[1]).toEqual({ state: "error", attempts: { lt: MAX_ATTEMPTS }, ...due });
  });

  it("rejected NO se reintenta solo: la DIAN ya evaluó ese XML", () => {
    const states = (where.AND[1] as { OR: Record<string, unknown>[] }).OR;
    expect(states.map((s) => s.state)).not.toContain("rejected");
    expect(states.map((s) => s.state)).not.toContain("accepted");
    expect(states.map((s) => s.state)).not.toContain("pending");
  });

  it("un `sent` que no volvió en 15 minutos se puede re-reclamar", () => {
    const states = (where.AND[1] as { OR: Record<string, unknown>[] }).OR;
    expect(states[2]).toEqual({
      state: "sent",
      updatedAt: { lt: new Date(NOW.getTime() - STALE_CLAIM_MS) },
    });
  });
});

describe("claimWhere — el cerrojo", () => {
  it("pasa a sent sólo desde reintentable o desde un sent vencido", () => {
    expect(claimWhere("doc-1", NOW)).toEqual({
      id: "doc-1",
      OR: [
        { state: { in: ["to_send", "error", "rejected"] } },
        { state: "sent", updatedAt: { lt: new Date(NOW.getTime() - STALE_CLAIM_MS) } },
      ],
    });
  });
});
