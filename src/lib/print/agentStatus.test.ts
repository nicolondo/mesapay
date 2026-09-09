import { describe, it, expect } from "vitest";
import {
  AGENT_LATE_MS,
  AGENT_ONLINE_MS,
  agentLiveness,
  humanizeAgo,
} from "./agentStatus";

const NOW = new Date("2026-09-08T20:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("agentLiveness", () => {
  it("sin lastSeenAt es 'nunca se conectó', no 'apagado'", () => {
    expect(agentLiveness(null, NOW)).toEqual({
      state: "never",
      sinceMs: 0,
      ago: null,
    });
  });

  it("un latido reciente es 'responde'", () => {
    expect(agentLiveness(ago(40 * 1000), NOW).state).toBe("online");
    expect(agentLiveness(ago(AGENT_ONLINE_MS - 1), NOW).state).toBe("online");
  });

  it("pasado el umbral entra en la zona gris", () => {
    expect(agentLiveness(ago(AGENT_ONLINE_MS), NOW).state).toBe("late");
    expect(agentLiveness(ago(5 * 60 * 1000), NOW).state).toBe("late");
  });

  it("pasados 10 minutos es 'sin responder' de verdad", () => {
    expect(agentLiveness(ago(AGENT_LATE_MS), NOW).state).toBe("offline");
    expect(agentLiveness(ago(12 * 60 * 1000), NOW).state).toBe("offline");
  });

  it("acepta la marca serializada que llega del servidor", () => {
    const live = agentLiveness(ago(40 * 1000).toISOString(), NOW);
    expect(live.state).toBe("online");
    expect(live.ago).toEqual({ unit: "seconds", value: 40 });
  });

  it("un reloj adelantado del agente no da 'hace -3 s'", () => {
    const live = agentLiveness(new Date(NOW.getTime() + 3000), NOW);
    expect(live.sinceMs).toBe(0);
    expect(live.state).toBe("online");
  });

  it("una fecha basura no rompe la pantalla", () => {
    expect(agentLiveness("no es una fecha", NOW).state).toBe("never");
  });
});

describe("humanizeAgo", () => {
  it("elige la unidad más grande que todavía dice algo", () => {
    expect(humanizeAgo(0)).toEqual({ unit: "seconds", value: 0 });
    expect(humanizeAgo(59_000)).toEqual({ unit: "seconds", value: 59 });
    expect(humanizeAgo(60_000)).toEqual({ unit: "minutes", value: 1 });
    expect(humanizeAgo(12 * 60_000)).toEqual({ unit: "minutes", value: 12 });
    expect(humanizeAgo(60 * 60_000)).toEqual({ unit: "hours", value: 1 });
    expect(humanizeAgo(25 * 60 * 60_000)).toEqual({ unit: "days", value: 1 });
  });
});
