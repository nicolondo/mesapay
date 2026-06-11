import { describe, it, expect } from "vitest";
import { computeTeamMetrics } from "./metrics";

// ── Fixtures ──────────────────────────────────────────────────────────────

const now = new Date("2026-06-11T12:00:00Z");
const rangeStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

const inRange = (daysAgo: number) =>
  new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);

const outOfRange = new Date(
  rangeStart.getTime() - 24 * 60 * 60 * 1000, // 1 day before range
);

// ── Tests ─────────────────────────────────────────────────────────────────

describe("computeTeamMetrics", () => {
  it("returns zeroes for a member with no leads", () => {
    const result = computeTeamMetrics(["u1"], [], [], rangeStart);
    expect(result).toHaveLength(1);
    const m = result[0];
    expect(m.leadsNuevos).toBe(0);
    expect(m.contactados).toBe(0);
    expect(m.demos).toBe(0);
    expect(m.ganados).toBe(0);
    expect(m.tasaConversion).toBe(0);
    expect(m.tiempoPrimeraRespuestaHrs).toBeNull();
  });

  it("counts leadsNuevos only in range", () => {
    const leads = [
      { id: "l1", assignedToUserId: "u1", createdAt: inRange(5), stage: "nuevo" },
      { id: "l2", assignedToUserId: "u1", createdAt: inRange(10), stage: "contactado" },
      { id: "l3", assignedToUserId: "u1", createdAt: outOfRange, stage: "nuevo" },
    ];
    const [m] = computeTeamMetrics(["u1"], leads, [], rangeStart);
    expect(m.leadsNuevos).toBe(2);
  });

  it("counts contactados as distinct leads with ≥1 activity in range", () => {
    const leads = [
      { id: "l1", assignedToUserId: "u1", createdAt: inRange(5), stage: "contactado" },
      { id: "l2", assignedToUserId: "u1", createdAt: inRange(8), stage: "nuevo" },
    ];
    const activities = [
      { leadId: "l1", userId: "u1", type: "note", content: "nota", createdAt: inRange(4) },
      { leadId: "l1", userId: "u1", type: "call", content: "llamada", createdAt: inRange(3) },
      // l2 has no activity
    ];
    const [m] = computeTeamMetrics(["u1"], leads, activities, rangeStart);
    expect(m.contactados).toBe(1);
  });

  it("counts demos from stage_change activities containing 'demo'", () => {
    const leads = [
      { id: "l1", assignedToUserId: "u1", createdAt: inRange(20), stage: "demo_agendada" },
      { id: "l2", assignedToUserId: "u1", createdAt: inRange(15), stage: "propuesta_enviada" },
    ];
    const activities = [
      {
        leadId: "l1", userId: "u1", type: "stage_change",
        content: "etapa: contactado → demo_agendada", createdAt: inRange(18),
      },
      {
        leadId: "l2", userId: "u1", type: "stage_change",
        content: "etapa: demo_agendada → propuesta_enviada", createdAt: inRange(12),
      },
    ];
    const [m] = computeTeamMetrics(["u1"], leads, activities, rangeStart);
    expect(m.demos).toBe(2); // both contain "demo"
  });

  it("counts ganados from stage_change activities containing 'ganado'", () => {
    const leads = [
      { id: "l1", assignedToUserId: "u1", createdAt: inRange(25), stage: "ganado" },
    ];
    const activities = [
      {
        leadId: "l1", userId: "u1", type: "stage_change",
        content: "Convertido en cliente ✓", createdAt: inRange(10),
      },
    ];
    // Note: "Convertido en cliente ✓" doesn't contain "ganado"
    const [m] = computeTeamMetrics(["u1"], leads, activities, rangeStart);
    expect(m.ganados).toBe(0); // no "ganado" in content

    // Now test with explicit "ganado" in content
    const activities2 = [
      {
        leadId: "l1", userId: "u1", type: "stage_change",
        content: "etapa: negociacion → ganado", createdAt: inRange(10),
      },
    ];
    const [m2] = computeTeamMetrics(["u1"], leads, activities2, rangeStart);
    expect(m2.ganados).toBe(1);
  });

  it("computes tasaConversion correctly", () => {
    const leads = [
      { id: "l1", assignedToUserId: "u1", createdAt: inRange(5), stage: "ganado" },
      { id: "l2", assignedToUserId: "u1", createdAt: inRange(6), stage: "nuevo" },
    ];
    const activities = [
      {
        leadId: "l1", userId: "u1", type: "stage_change",
        content: "etapa: negociacion → ganado", createdAt: inRange(3),
      },
    ];
    const [m] = computeTeamMetrics(["u1"], leads, activities, rangeStart);
    expect(m.leadsNuevos).toBe(2);
    expect(m.ganados).toBe(1);
    expect(m.tasaConversion).toBeCloseTo(0.5);
  });

  it("computes tiempoPrimeraRespuestaHrs", () => {
    const createdAt = inRange(10);
    // First activity 2 hours later.
    const firstAct = new Date(createdAt.getTime() + 2 * 60 * 60 * 1000);
    const leads = [
      { id: "l1", assignedToUserId: "u1", createdAt, stage: "contactado" },
    ];
    const activities = [
      { leadId: "l1", userId: "u1", type: "note", content: "", createdAt: firstAct },
    ];
    const [m] = computeTeamMetrics(["u1"], leads, activities, rangeStart);
    expect(m.tiempoPrimeraRespuestaHrs).toBeCloseTo(2);
  });

  it("returns null tiempoPrimeraRespuestaHrs when no activities on range leads", () => {
    const leads = [
      { id: "l1", assignedToUserId: "u1", createdAt: inRange(5), stage: "nuevo" },
    ];
    const [m] = computeTeamMetrics(["u1"], leads, [], rangeStart);
    expect(m.tiempoPrimeraRespuestaHrs).toBeNull();
  });

  it("handles multiple members independently", () => {
    const leads = [
      { id: "l1", assignedToUserId: "u1", createdAt: inRange(2), stage: "nuevo" },
      { id: "l2", assignedToUserId: "u2", createdAt: inRange(5), stage: "ganado" },
      { id: "l3", assignedToUserId: "u2", createdAt: inRange(7), stage: "nuevo" },
    ];
    const activities = [
      {
        leadId: "l2", userId: "u2", type: "stage_change",
        content: "etapa: negociacion → ganado", createdAt: inRange(3),
      },
    ];
    const metrics = computeTeamMetrics(["u1", "u2"], leads, activities, rangeStart);
    const u1 = metrics.find((m) => m.memberId === "u1")!;
    const u2 = metrics.find((m) => m.memberId === "u2")!;

    expect(u1.leadsNuevos).toBe(1);
    expect(u1.ganados).toBe(0);

    expect(u2.leadsNuevos).toBe(2);
    expect(u2.ganados).toBe(1);
    expect(u2.tasaConversion).toBeCloseTo(0.5);
  });
});
