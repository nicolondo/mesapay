import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El encolado sin destino tiene que dejar rastro. Un comercio prendió la
 * impresión del bar sin impresora de bar y la comanda "no salió" sin una
 * sola línea de log: `enqueueRoundTicket` devolvía 0 en silencio.
 */

type PrinterRow = {
  id: string;
  kind: string;
  station: string;
  barSubStation: string | null;
  paperWidthMm: number | null;
};

const h = vi.hoisted(() => ({
  printers: vi.fn(async (): Promise<PrinterRow[]> => []),
  round: vi.fn(async () => null),
  createMany: vi.fn(async () => ({ count: 0 })),
}));
vi.mock("@/lib/db", () => ({
  db: {
    printer: { findMany: h.printers },
    round: { findUnique: h.round },
    printJob: { createMany: h.createMany },
  },
}));
vi.mock("@/lib/events", () => ({ publishOrderEvent: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "es",
  getTranslations: async () => (key: string) => key,
}));

import { enqueueRoundTicket } from "./enqueue";

const args = {
  restaurantId: "merchant",
  orderId: "order",
  roundId: "round",
  station: "bar" as const,
  barSubStation: "cocteles",
};
const barPrinter = (barSubStation: string | null): PrinterRow => ({
  id: "printer",
  kind: "comanda",
  station: "bar",
  barSubStation,
  paperWidthMm: 80,
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("enqueueRoundTicket sin impresora que sirva", () => {
  it("sin ninguna impresora activa de la estación avisa y no encola", async () => {
    expect(await enqueueRoundTicket(args)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[print-queue] sin impresoras activas para la estación",
      {
        restaurantId: "merchant",
        roundId: "round",
        station: "bar",
        barSubStation: "cocteles",
        registered: 0,
        reason: "none_registered",
      },
    );
    expect(h.round).not.toHaveBeenCalled();
    expect(h.createMany).not.toHaveBeenCalled();
  });

  it("con impresoras del bar que no sirven a la sub-estación lo dice distinto", async () => {
    h.printers.mockResolvedValueOnce([barPrinter("cafe")]);
    expect(await enqueueRoundTicket(args)).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "[print-queue] sin impresoras activas para la estación",
      expect.objectContaining({ registered: 1, reason: "no_sub_station_match" }),
    );
    expect(h.createMany).not.toHaveBeenCalled();
  });

  it("una impresora 'de toda la barra' sí sirve: no avisa nada", async () => {
    h.printers.mockResolvedValueOnce([barPrinter(null)]);
    // La ronda no existe en este doble, así que termina en 0 igual — pero
    // por otro camino, y sin la advertencia de "sin impresoras".
    expect(await enqueueRoundTicket(args)).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(h.round).toHaveBeenCalled();
  });
});
