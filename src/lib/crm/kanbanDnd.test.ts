import { describe, it, expect } from "vitest";
import { applyDrop, applyDropCounts } from "./kanbanDnd";
import type { LeadCard } from "@/app/comercial/crm/CrmPipelineClient";

function makeLeads(): LeadCard[] {
  return [
    {
      id: "a",
      stage: "nuevo",
      name: "Alpha",
      priority: "a",
      countryCode: "CO",
      lastActivityAt: null,
      nextActionAt: null,
      createdAt: new Date().toISOString(),
      city: null,
      assignedTo: null,
      contacts: [],
    },
    {
      id: "b",
      stage: "nuevo",
      name: "Beta",
      priority: "b",
      countryCode: "CO",
      lastActivityAt: null,
      nextActionAt: null,
      createdAt: new Date().toISOString(),
      city: null,
      assignedTo: null,
      contacts: [],
    },
    {
      id: "c",
      stage: "contactado",
      name: "Gamma",
      priority: "c",
      countryCode: "CO",
      lastActivityAt: null,
      nextActionAt: null,
      createdAt: new Date().toISOString(),
      city: null,
      assignedTo: null,
      contacts: [],
    },
  ];
}

describe("applyDrop", () => {
  it("moves lead from one stage to another", () => {
    const leads = makeLeads();
    const result = applyDrop(leads, "a", "nuevo", "contactado");
    const moved = result.find((l) => l.id === "a");
    expect(moved?.stage).toBe("contactado");
  });

  it("leaves other leads unchanged", () => {
    const leads = makeLeads();
    const result = applyDrop(leads, "a", "nuevo", "contactado");
    expect(result.find((l) => l.id === "b")?.stage).toBe("nuevo");
    expect(result.find((l) => l.id === "c")?.stage).toBe("contactado");
  });

  it("no-op when same stage: stage stays unchanged", () => {
    const leads = makeLeads();
    const result = applyDrop(leads, "a", "nuevo", "nuevo");
    expect(result.find((l) => l.id === "a")?.stage).toBe("nuevo");
  });

  it("does not mutate original array", () => {
    const leads = makeLeads();
    applyDrop(leads, "a", "nuevo", "contactado");
    expect(leads[0].stage).toBe("nuevo");
  });
});

describe("applyDropCounts", () => {
  it("decrements fromStage and increments toStage", () => {
    const counts = { nuevo: 2, contactado: 1, total: 3 };
    const result = applyDropCounts(counts, "nuevo", "contactado");
    expect(result.nuevo).toBe(1);
    expect(result.contactado).toBe(2);
    expect(result.total).toBe(3); // total unchanged
  });

  it("does not go below 0 for fromStage", () => {
    const counts = { nuevo: 0, contactado: 1 };
    const result = applyDropCounts(counts, "nuevo", "contactado");
    expect(result.nuevo).toBe(0);
    expect(result.contactado).toBe(2);
  });

  it("creates missing keys with correct values", () => {
    const counts: Record<string, number> = {};
    const result = applyDropCounts(counts, "nuevo", "contactado");
    expect(result.nuevo).toBe(0);
    expect(result.contactado).toBe(1);
  });

  it("does not mutate original counts", () => {
    const counts = { nuevo: 2, contactado: 1 };
    applyDropCounts(counts, "nuevo", "contactado");
    expect(counts.nuevo).toBe(2);
  });
});
