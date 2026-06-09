import { describe, it, expect } from "vitest";
import { localParts, dateKeyInTz } from "./timeBuckets";

describe("localParts", () => {
  it("convierte UTC a hora local de Bogotá (UTC-5)", () => {
    // 2026-03-10T02:30:00Z = 2026-03-09 21:30 en Bogotá
    const p = localParts(new Date("2026-03-10T02:30:00Z"), "America/Bogota");
    expect(p.dateKey).toBe("2026-03-09");
    expect(p.hour).toBe(21);
    expect(p.dow).toBe(1); // lunes
  });
  it("dow: 0=domingo .. 6=sábado", () => {
    // 2026-03-08 es domingo
    const p = localParts(new Date("2026-03-08T15:00:00Z"), "America/Bogota");
    expect(p.dow).toBe(0);
  });
});

describe("dateKeyInTz", () => {
  it("agrupa por semana ISO (lunes) y mes", () => {
    expect(dateKeyInTz(new Date("2026-03-10T12:00:00Z"), "America/Bogota", "month")).toBe("2026-03");
    expect(dateKeyInTz(new Date("2026-03-10T12:00:00Z"), "America/Bogota", "day")).toBe("2026-03-10");
  });
});
