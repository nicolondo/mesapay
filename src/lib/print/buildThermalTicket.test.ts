import { describe, expect, it, vi } from "vitest";
import es from "../../../messages/es.json";
import en from "../../../messages/en.json";
import pt from "../../../messages/pt.json";

/**
 * La línea "MONTÓ: JUAN (MESERO)" de la comanda térmica sale del catálogo
 * REAL (opPrint + kitchen) en el idioma de impresión: si alguien renombra
 * una clave o deja un idioma sin traducir, revienta acá y no en una cocina.
 */
const catalogs: Record<string, Record<string, Record<string, string>>> = {
  es: es as never,
  en: en as never,
  pt: pt as never,
};
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "es",
  getTranslations: async ({ locale, namespace }: { locale: string; namespace: string }) => {
    const ns = catalogs[locale][namespace];
    return (key: string, values?: Record<string, string | number>) => {
      const msg = ns[key];
      if (typeof msg !== "string") throw new Error(`falta ${locale}.${namespace}.${key}`);
      return msg.replace(/\{(\w+)\}/g, (_, k) => String(values?.[k] ?? `{${k}}`));
    };
  },
}));

import { buildThermalTicket } from "./enqueue";
import type { RoundTicket } from "./ticketData";

const base: RoundTicket = {
  restaurantName: "Donde Chucho",
  paperWidthMm: 80,
  station: "kitchen",
  barSubStation: null,
  roundSeq: 2,
  placedAt: new Date("2026-09-18T19:41:00-05:00"),
  placedBy: null,
  order: {
    shortCode: "A4F2",
    orderType: "dineIn",
    tableNumber: 7,
    pickupName: null,
    notes: null,
    servingMode: "asReady",
  },
  items: [{ qty: 1, name: "Bandeja paisa", modifiers: [], notes: null, guestName: null }],
};

describe("buildThermalTicket — quién montó la ronda", () => {
  it("pidió el comensal: sin línea, y el resto de la comanda igual que siempre", async () => {
    const t = await buildThermalTicket(base, 80, "es");
    expect(t.placedByLine).toBeNull();
    expect(t.destinationLine).toBe("MESA 7");
    expect(t.metaLine.startsWith("A4F2 · R2 · ")).toBe(true);
  });

  it("montó un mesero: nombre y rol en mayúsculas, en español", async () => {
    const t = await buildThermalTicket(
      { ...base, placedBy: { name: "Juan", role: "mesero" } },
      80,
      "es",
    );
    expect(t.placedByLine).toBe("MONTÓ: JUAN (MESERO)");
  });

  it("la etiqueta del rol sale en el idioma de impresión", async () => {
    const admin = { name: "Ana", role: "operator" };
    expect((await buildThermalTicket({ ...base, placedBy: admin }, 80, "en")).placedByLine).toBe(
      "PLACED BY: ANA (ADMIN)",
    );
    expect((await buildThermalTicket({ ...base, placedBy: admin }, 80, "pt")).placedByLine).toBe(
      "LANÇOU: ANA (ADMINISTRADOR)",
    );
  });

  it("cada rol que monta tiene etiqueta en los tres idiomas", async () => {
    for (const role of ["mesero", "operator", "kitchen", "bar", "terminal", "group_admin", "platform_admin"]) {
      for (const locale of ["es", "en", "pt"] as const) {
        const t = await buildThermalTicket({ ...base, placedBy: { name: "X", role } }, 80, locale);
        expect(t.placedByLine).toMatch(/^[^{}]+: X \([^{}]+\)$/);
      }
    }
  });

  it("un rol que ya no existe imprime sólo el nombre", async () => {
    const t = await buildThermalTicket(
      { ...base, placedBy: { name: "Juan", role: "rol_viejo" } },
      80,
      "es",
    );
    expect(t.placedByLine).toBe("MONTÓ: JUAN");
  });
});
