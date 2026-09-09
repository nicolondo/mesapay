import { describe, expect, it } from "vitest";
import {
  CLAIM_RETRY_MS,
  JOB_TTL_MS,
  MAX_ATTEMPTS,
  claimableWhere,
  normalizeLimit,
  retryBackoffMs,
  selectClaimable,
  shouldRetryAfterFailure,
  type ClaimableJob,
} from "./claim";
import { printerMatches, ticketDedupeKey } from "./routing";

const NOW = new Date("2026-09-08T19:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function job(over: Partial<ClaimableJob> = {}): ClaimableJob {
  return {
    id: "job1",
    restaurantId: "rest-a",
    status: "pending",
    attempts: 0,
    createdAt: ago(60_000),
    deliveredAt: null,
    nextAttemptAt: null,
    ...over,
  };
}

describe("selectClaimable — multi-tenant", () => {
  it("NUNCA devuelve trabajos de otro restaurante", () => {
    const rows = [
      job({ id: "mio", restaurantId: "rest-a" }),
      job({ id: "ajeno", restaurantId: "rest-b" }),
      job({ id: "ajeno2", restaurantId: "rest-c" }),
    ];
    expect(selectClaimable(rows, "rest-a", NOW).map((j) => j.id)).toEqual([
      "mio",
    ]);
    expect(selectClaimable(rows, "rest-b", NOW).map((j) => j.id)).toEqual([
      "ajeno",
    ]);
    // Un token de un restaurante que no tiene nada no ve absolutamente nada.
    expect(selectClaimable(rows, "rest-z", NOW)).toEqual([]);
  });

  it("el where que va a la DB también está acotado al restaurante", () => {
    const where = claimableWhere("rest-a", NOW);
    expect(where.restaurantId).toBe("rest-a");
    expect(where.attempts).toEqual({ lt: MAX_ATTEMPTS });
    expect(where.printer).toEqual({ active: true });
  });
});

describe("selectClaimable — reintentos", () => {
  it("un trabajo entregado y confirmado no vuelve nunca", () => {
    const rows = [
      job({ id: "impreso", status: "printed", deliveredAt: ago(10 * 60_000) }),
      job({ id: "fallido", status: "failed" }),
    ];
    expect(selectClaimable(rows, "rest-a", NOW)).toEqual([]);
  });

  it("un trabajo entregado y NO confirmado no se re-entrega enseguida", () => {
    const rows = [
      job({
        id: "en-vuelo",
        status: "delivered",
        attempts: 1,
        deliveredAt: ago(CLAIM_RETRY_MS - 1_000),
      }),
    ];
    expect(selectClaimable(rows, "rest-a", NOW)).toEqual([]);
  });

  it("pero sí pasada la ventana — el PC se pudo apagar entre recibir e imprimir", () => {
    const rows = [
      job({
        id: "huerfano",
        status: "delivered",
        attempts: 1,
        deliveredAt: ago(CLAIM_RETRY_MS + 1_000),
      }),
    ];
    expect(selectClaimable(rows, "rest-a", NOW).map((j) => j.id)).toEqual([
      "huerfano",
    ]);
  });

  it("respeta la espera que puso el acuse fallido", () => {
    const enEspera = job({
      id: "esperando",
      status: "pending",
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + 15_000),
    });
    expect(selectClaimable([enEspera], "rest-a", NOW)).toEqual([]);
    const yaPuede = { ...enEspera, nextAttemptAt: ago(1_000) };
    expect(selectClaimable([yaPuede], "rest-a", NOW)).toHaveLength(1);
  });

  it("deja de entregar al llegar al tope de intentos", () => {
    const rows = [
      job({ id: "quemado", attempts: MAX_ATTEMPTS }),
      job({ id: "vivo", attempts: MAX_ATTEMPTS - 1 }),
    ];
    expect(selectClaimable(rows, "rest-a", NOW).map((j) => j.id)).toEqual([
      "vivo",
    ]);
  });

  it("no imprime el servicio de ayer cuando el PC vuelve a prender", () => {
    const rows = [
      job({ id: "viejo", createdAt: ago(JOB_TTL_MS + 60_000) }),
      job({ id: "reciente", createdAt: ago(5 * 60_000) }),
    ];
    expect(selectClaimable(rows, "rest-a", NOW).map((j) => j.id)).toEqual([
      "reciente",
    ]);
  });

  it("entrega en orden de llegada y respeta el límite", () => {
    const rows = [
      job({ id: "c", createdAt: ago(10_000) }),
      job({ id: "a", createdAt: ago(30_000) }),
      job({ id: "b", createdAt: ago(20_000) }),
    ];
    expect(selectClaimable(rows, "rest-a", NOW, 2).map((j) => j.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("política de reintentos", () => {
  it("reintenta hasta el tope y ahí se rinde", () => {
    expect(shouldRetryAfterFailure(1)).toBe(true);
    expect(shouldRetryAfterFailure(MAX_ATTEMPTS - 1)).toBe(true);
    expect(shouldRetryAfterFailure(MAX_ATTEMPTS)).toBe(false);
  });

  it("la espera crece con los intentos (da tiempo a re-enchufar la impresora)", () => {
    expect(retryBackoffMs(1)).toBe(30_000);
    expect(retryBackoffMs(4)).toBe(120_000);
    expect(retryBackoffMs(0)).toBe(30_000);
  });
});

describe("normalizeLimit", () => {
  it("acota lo que pida el agente", () => {
    expect(normalizeLimit(null)).toBe(10);
    expect(normalizeLimit("abc")).toBe(10);
    expect(normalizeLimit("0")).toBe(10);
    expect(normalizeLimit("-5")).toBe(10);
    expect(normalizeLimit("3")).toBe(3);
    expect(normalizeLimit("9999")).toBe(50);
  });
});

describe("ruteo a impresoras", () => {
  const cocina = { station: "kitchen", barSubStation: null };
  const barraTodo = { station: "bar", barSubStation: null };
  const barraCocteles = { station: "bar", barSubStation: "Cocteles" };

  it("cada impresora sólo recibe su estación", () => {
    expect(printerMatches(cocina, "kitchen", null)).toBe(true);
    expect(printerMatches(cocina, "bar", null)).toBe(false);
    expect(printerMatches(barraTodo, "kitchen", null)).toBe(false);
  });

  it("la impresora sin sub-estación es 'toda la barra' y recibe todo", () => {
    expect(printerMatches(barraTodo, "bar", null)).toBe(true);
    expect(printerMatches(barraTodo, "bar", "Cocteles")).toBe(true);
    expect(printerMatches(barraTodo, "bar", "Cafe")).toBe(true);
  });

  it("la impresora con sub-estación sólo recibe la suya", () => {
    expect(printerMatches(barraCocteles, "bar", "Cocteles")).toBe(true);
    expect(printerMatches(barraCocteles, "bar", "Cafe")).toBe(false);
    expect(printerMatches(barraCocteles, "bar", null)).toBe(false);
  });
});

describe("ticketDedupeKey", () => {
  it("la misma ronda/estación da la misma clave — el KDS marca plato por plato", () => {
    expect(ticketDedupeKey("r1", "kitchen", null)).toBe(
      ticketDedupeKey("r1", "kitchen", null),
    );
  });

  it("distinta estación o sub-estación son comandas distintas", () => {
    expect(ticketDedupeKey("r1", "kitchen", null)).not.toBe(
      ticketDedupeKey("r1", "bar", null),
    );
    expect(ticketDedupeKey("r1", "bar", "Cocteles")).not.toBe(
      ticketDedupeKey("r1", "bar", "Cafe"),
    );
  });
});
