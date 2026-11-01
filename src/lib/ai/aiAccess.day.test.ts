// El límite diario de Pulso se reinicia a la medianoche del COMERCIO, no a
// la del servidor (UTC, que en Colombia son las 7 p. m.).
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ count: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { aiMessage: { count: m.count } } }));

import { localIsoDate, messagesUsedToday, startOfLocalDay } from "./aiAccess";

describe("startOfLocalDay / localIsoDate", () => {
  it("a las 8 p. m. de Bogotá (ya 1:00 UTC del día siguiente) el día sigue siendo el de Bogotá", () => {
    const now = new Date("2026-11-01T01:00:00Z"); // 31-oct 20:00 en Bogotá
    expect(localIsoDate(now, "America/Bogota")).toBe("2026-10-31");
    expect(startOfLocalDay(now, "America/Bogota").toISOString()).toBe("2026-10-31T05:00:00.000Z");
  });

  it("justo después de la medianoche de Bogotá arranca el día nuevo", () => {
    const now = new Date("2026-11-01T05:00:01Z");
    expect(localIsoDate(now, "America/Bogota")).toBe("2026-11-01");
    expect(startOfLocalDay(now, "America/Bogota").toISOString()).toBe("2026-11-01T05:00:00.000Z");
  });

  it("respeta otras zonas (Ciudad de México, UTC−6)", () => {
    const now = new Date("2026-11-01T05:30:00Z"); // 31-oct 23:30 en CDMX
    expect(startOfLocalDay(now, "America/Mexico_City").toISOString()).toBe("2026-10-31T06:00:00.000Z");
  });
});

describe("messagesUsedToday", () => {
  it("cuenta los mensajes desde la medianoche del comercio", async () => {
    m.count.mockResolvedValue(7);
    const n = await messagesUsedToday("r1", { now: new Date("2026-11-01T01:00:00Z") });
    expect(n).toBe(7);
    expect(m.count).toHaveBeenCalledWith({
      where: {
        role: "user",
        createdAt: { gte: new Date("2026-10-31T05:00:00.000Z") },
        conversation: { restaurantId: "r1" },
      },
    });
  });
});
